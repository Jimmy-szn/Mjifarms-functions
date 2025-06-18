// api/index.js

const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase Admin SDK using environment variable
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountBase64) {
    console.error("FIREBASE_SERVICE_ACCOUNT environment variable is not set. Please set it in Vercel project settings.");
    // Return a function that always responds with an error if critical env var is missing
    module.exports = (req, res) => res.status(500).json({ status: 'error', message: 'Server configuration error: Firebase credentials missing.' });
    return; // Exit module loading
}

let serviceAccount;
try {
    serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
} catch (e) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT:", e);
    module.exports = (req, res) => res.status(500).json({ status: 'error', message: 'Server configuration error: Invalid Firebase credentials format.' });
    return; // Exit module loading
}

// Initialize Firebase Admin SDK only once (for Realtime Database)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // IMPORTANT: Replace with your Firebase Realtime Database URL
        databaseURL: "https://project-theta-a1044-default-rtdb.firebaseio.com/" // Placeholder, replace with your actual URL
    });
}
const db = admin.database(); // Get Realtime Database instance

const PLANTID_API_KEY = process.env.PLANTID_API_KEY;

// Main handler for all incoming requests
module.exports = async (req, res) => {
    // --- START CORS HEADERS (Explicitly handled within the function) ---
    // These headers are set for every response, including OPTIONS.
    res.setHeader('Access-Control-Allow-Origin', '*'); // CHANGED: Still wildcard for dev
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); // CHANGED: Explicitly allowing OPTIONS
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // CHANGED: Allowing necessary headers
    res.setHeader('Access-Control-Max-Age', '86400'); // CHANGED: Caching preflight response

    // CHANGED: Handle OPTIONS preflight request - crucial for CORS
    if (req.method === 'OPTIONS') {
        return res.status(204).end(); // 204 No Content for successful preflight
    }
    // --- END CORS HEADERS ---

    // Check if the Plant.id API key is configured
    if (!PLANTID_API_KEY) {
        console.error("PLANTID_API_KEY is not configured in Vercel environment variables.");
        return res.status(500).json({ status: 'error', message: 'Server Error: Plant.id API Key not configured.' });
    }

    // Determine if the URL is the root, handling variations (e.g., '', '/')
    const isRootUrl = (url) => url === '/' || url === '';

    // --- REVISED ROUTING LOGIC START ---
    // Handle POST requests for diagnosis at the '/diagnose' path
    if (req.url === '/diagnose' && req.method === 'POST') { // CHANGED: Explicitly checking for '/diagnose' path and POST method
        console.log("Matched POST request to /diagnose for plant diagnosis."); // For debugging Vercel logs

        // 1. Authenticate User (Verify Firebase ID Token)
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: No token provided or invalid format.' });
        }
        const idToken = authHeader.split('Bearer ')[1];

        let decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(idToken);
            // const userId = decodedToken.uid; // User ID of the authenticated user
        } catch (error) {
            console.error("Error verifying Firebase ID token:", error);
            return res.status(401).json({ message: 'Unauthorized: Invalid token.', error: error.message });
        }

        // CHANGED: Destructure latitude, longitude from req.body (optional from Flutter)
        const { base64Image, cropLogId, plantId, latitude, longitude } = req.body;

        if (!base64Image || !cropLogId || !plantId) {
            return res.status(400).json({ message: 'Bad Request: Missing base64Image, cropLogId, or plantId.' });
        }

        // --- CHANGED: STRICTLY MATCHING CURL EXAMPLE FOR PLANT.ID API v3 health_assessment ---
        const PLANTID_ENDPOINT = 'https://plant.id/api/v3/health_assessment'; // CHANGED: Corrected to v3 health_assessment

        // CHANGED: Construct the payload as per the curl example
        const plantIdPayload = {
            api_key: PLANTID_API_KEY,
            images: [base64Image],
            // CHANGED: Only include latitude and longitude if they are provided from Flutter
            ...(latitude !== undefined && latitude !== null && { latitude: latitude }),
            ...(longitude !== undefined && longitude !== null && { longitude: longitude }),
            similar_images: true // CHANGED: As per curl example
        };

        try {
            // 2. Make API Call to Plant.id with the strictly formatted payload
            const apiCallResponse = await axios.post(PLANTID_ENDPOINT, plantIdPayload, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const apiResponse = apiCallResponse.data;
            console.log('Plant.id API Response:', JSON.stringify(apiResponse, null, 2));

            // 3. Process API Response and Extract Diagnosis Data
            // Assuming apiResponse is the parsed JSON object you provided
            // i.e., const apiResponse = apiCallResponse.data;

            let diagnosisDetails = {
                pestOrDisease: "Unknown Issue",
                confidenceLevel: 0,
                recommendations: [], // Will be populated if available
                relatedDiseaseImages: [],
            };

            if (apiResponse && apiResponse.result) {
                const result = apiResponse.result;

                // 1. Determine if the plant is healthy or unhealthy
                if (result.is_healthy && result.is_healthy.binary === true) {
                    diagnosisDetails.pestOrDisease = "Plant appears healthy!";
                    diagnosisDetails.confidenceLevel = result.is_healthy.probability * 100;
                    // Healthy plants might not have specific recommendations or related images
                } else if (result.disease && result.disease.suggestions && result.disease.suggestions.length > 0) {
                    // 2. Get the top (most probable) suggestion if unhealthy
                    const topSuggestion = result.disease.suggestions[0];
                    diagnosisDetails.pestOrDisease = topSuggestion.name;
                    diagnosisDetails.confidenceLevel = topSuggestion.probability * 100; // Convert to percentage

                    // 3. Extract recommendations (if 'details' were requested in Plant.id API call)
                    // IMPORTANT: The 'details' object in your provided JSON example does NOT contain 'description' or 'treatment'.
                    // If you want recommendations, you MUST include 'details: ["description", "treatment"]'
                    // in your request payload to the Plant.id API when calling it from Vercel.
                    // For example:
                    // 'details': ["description", "treatment", "url"],
                    if (topSuggestion.details) {
                        if (topSuggestion.details.description) {
                            diagnosisDetails.recommendations.push(topSuggestion.details.description);
                        }
                        if (topSuggestion.details.treatment) {
                            // If treatment is an array of strings, add each. If it's a single string, add it.
                            if (Array.isArray(topSuggestion.details.treatment)) {
                                diagnosisDetails.recommendations.push(...topSuggestion.details.treatment);
                            } else if (typeof topSuggestion.details.treatment === 'string') {
                                diagnosisDetails.recommendations.push(topSuggestion.details.treatment);
                            }
                        }
                        // You might also find common_names, taxonomy, etc., under details if requested.
                    }

                    // 4. Extract similar image URLs
                    if (topSuggestion.similar_images && topSuggestion.similar_images.length > 0) {
                        diagnosisDetails.relatedDiseaseImages = topSuggestion.similar_images.map(img => img.url);
                    }
                } else {
                    diagnosisDetails.pestOrDisease = "Could not determine plant health or specific issue.";
                }

                // 5. Consider the 'question' field for interactive diagnosis (optional, for future enhancements)
                // The 'question' field (e.g., result.disease.question.text, result.disease.question.options)
                // can be used to ask follow-up questions to the farmer for more accurate diagnosis.
                // Your current Flutter UI doesn't support this interactivity, but it's available in the API response.
                if (result.disease && result.disease.question) {
                    console.log("Plant.id suggested a follow-up question:", result.disease.question.text);
                    // You could pass this question back to Flutter and prompt the user for a Yes/No answer
                    // to send another diagnosis request with the selected option.
                }
            }

            // This `diagnosisDetails` object is what you would send back to your Flutter app
            // and save to Firebase Realtime Database.
            console.log('Processed Diagnosis Details for Farmer:', diagnosisDetails);

            // Example of how you would respond from your Vercel function:
            // res.status(200).json({
            //     status: 'success',
            //     message: 'Diagnosis successful',
            //     diagnosisId: newDiagnosisRef.key, // Assuming you save it to Firebase and get a key
            //     diagnosisDetails: diagnosisDetails // Send the processed data to Flutter
            // });

            // 4. Store Diagnosis in Realtime Database
            // Structure: /crop_logs/{cropLogId}/diagnoses/{diagnosisId}
            const diagnosisRef = db.ref(`crop_logs/${cropLogId}/diagnoses`).push(); // Generates a unique key
            const diagnosisId = diagnosisRef.key; // Get the generated key

            await diagnosisRef.set(diagnosisDetails); // Save the data

            // 5. Send Response to Flutter App
            return res.status(200).json({ status: 'success', diagnosisId: diagnosisId, diagnosisDetails: diagnosisData });

        } catch (error) {
            console.error("Error during Plant.id API call or Realtime Database write:", error);
            if (error.response) {
                console.error("Plant.id API Error Response (Status:", error.response.status, "):", error.response.data);
                return res.status(error.response.status || 500).json({
                    status: 'error',
                    message: `Plant.id API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
                });
            } else if (error.request) {
                console.error("Plant.id API No Response:", error.request);
                return res.status(503).json({ status: 'error', message: 'No response received from Plant.id API.' });
            } else {
                console.error("Error setting up Plant.id API request:", error.message);
                return res.status(500).json({ status: 'error', message: `Failed to diagnose plant: ${error.message}` });
            }
        }
    } else if (isRootUrl(req.url) && req.method === 'GET') {
        console.log("Matched GET request to root URL for health check."); // For debugging Vercel logs
        // --- Default / endpoint (Health Check) ---
        res.status(200).json({
            message: 'Welcome to the Urban Farming Assistant App API!',
            endpoint: req.url,
            method: req.method,
            status: 'ready'
        });
    } else {
        console.log(`No matching route or method: Method = ${req.method}, URL = ${req.url}`);
        // Handle other/unsupported routes/methods
        return res.status(404).json({ message: 'Not Found or Method Not Allowed', endpoint: req.url, method: req.method });
    }
    // --- REVISED ROUTING LOGIC END ---
};
