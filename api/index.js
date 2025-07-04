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
    res.setHeader('Access-Control-Allow-Origin', '*'); // Temporarily allow all origins for debugging
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); // Explicitly allowing OPTIONS
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Allowing necessary headers
    res.setHeader('Access-Control-Max-Age', '86400'); // Caching preflight response

    // Handle OPTIONS preflight request - crucial for CORS
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
    if (req.url === '/diagnose' && req.method === 'POST') {
        console.log("Matched POST request to /diagnose for plant diagnosis.");

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

        const userId = decodedToken.uid; // Extract userId after successful token verification

        const { base64Image, cropLogId, plantId, latitude, longitude } = req.body; 

        if (!base64Image || !cropLogId || !plantId) {
            return res.status(400).json({ message: 'Bad Request: Missing base64Image, cropLogId, or plantId.' });
        }

        // --- STRICTLY MATCHING CURL EXAMPLE FOR PLANT.ID API v3 health_assessment ---
        const PLANTID_ENDPOINT = 'https://plant.id/api/v3/health_assessment'; 
        
        const plantIdPayload = {
            api_key: PLANTID_API_KEY,
            images: [base64Image],
            // Only include latitude and longitude if they are provided from Flutter
            ...(latitude !== undefined && latitude !== null && { latitude: latitude }),
            ...(longitude !== undefined && longitude !== null && { longitude: longitude }),
            similar_images: true // As per curl example, crucial for getting related images
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
            const diagnosisData = {
                date: admin.database.ServerValue.TIMESTAMP,
                source: "AI_Plant.id",
                confidenceLevel: 0,
                pestOrDisease: "Unknown Issue", // Initialize as Unknown
                recommendations: [],
                relatedDiseaseImages: [], // To store URLs of related disease images
                rawApiResponse: apiResponse, // Store raw response for debugging/future analysis
                userId: userId, // Store the userId who made this diagnosis
                cropLogId: cropLogId, // Store the cropLogId for this diagnosis
                plantId: plantId, // Store the plantId for this diagnosis
                reviewStatus: 'none', // Initial status for expert review
                latitude: latitude, // Store location if available
                longitude: longitude, // Store location if available
            };

            const result = apiResponse.result;

            if (result) {
                // First, try to get a specific disease/pest suggestion from result.disease.suggestions
                if (result.disease && result.disease.suggestions && result.disease.suggestions.length > 0) {
                    const topSuggestion = result.disease.suggestions[0];
                    diagnosisData.pestOrDisease = topSuggestion.name; // Use the name from the top suggestion
                    diagnosisData.confidenceLevel = topSuggestion.probability * 100; // Convert to percentage

                    // Extract recommendations from details if available
                    if (topSuggestion.details) {
                        if (topSuggestion.details.description) {
                            // Ensure description.value is accessed if 'description' is an object
                            diagnosisData.recommendations.push(topSuggestion.details.description.value || topSuggestion.details.description);
                        }
                        if (topSuggestion.details.treatment) {
                            if (Array.isArray(topSuggestion.details.treatment)) {
                                diagnosisData.recommendations.push(...topSuggestion.details.treatment.map(t => t.value || t));
                            } else if (topSuggestion.details.treatment.value) {
                                diagnosisData.recommendations.push(topSuggestion.details.treatment.value);
                            } else if (typeof topSuggestion.details.treatment === 'string') {
                                diagnosisData.recommendations.push(topSuggestion.details.treatment);
                            }
                        }
                    }
                    
                    // Fallback recommendation if specific details weren't extracted
                    if (diagnosisData.recommendations.length === 0) {
                        diagnosisData.recommendations.push(`Possible issue: ${topSuggestion.name}.`);
                    }

                    // Extract similar images for ALL identified suggestions
                    result.disease.suggestions.forEach(suggestion => {
                        if (suggestion.similar_images && Array.isArray(suggestion.similar_images)) {
                            suggestion.similar_images.forEach(img => {
                                if (img.url) {
                                    diagnosisData.relatedDiseaseImages.push(img.url);
                                }
                            });
                        }
                    });
                } else if (result.is_healthy && typeof result.is_healthy.binary !== 'undefined') {
                    // If no specific disease suggestion, check the overall health status
                    if (result.is_healthy.binary === true) {
                        diagnosisData.pestOrDisease = "Healthy";
                        diagnosisData.confidenceLevel = result.is_healthy.probability * 100;
                        diagnosisData.recommendations.push("Your plant appears healthy!");
                    } else if (result.is_healthy.binary === false) {
                        diagnosisData.pestOrDisease = "Unhealthy - No specific issue identified.";
                        diagnosisData.confidenceLevel = result.is_healthy.probability * 100;
                        diagnosisData.recommendations.push("The plant appears unhealthy, but a specific issue could not be identified. Please try a clearer photo or consult an expert.");
                    }
                } else if (apiResponse.suggestions && apiResponse.suggestions.length > 0) {
                    // Fallback for general plant identification if neither health nor disease is clear
                    const topSuggestion = apiResponse.suggestions[0];
                    diagnosisData.pestOrDisease = `Identified as: ${topSuggestion.plant_name}`;
                    diagnosisData.confidenceLevel = topSuggestion.probability * 100;
                    diagnosisData.recommendations.push("No specific health issue detected, but the plant is identified as " + topSuggestion.plant_name + ".");
                    
                    if (topSuggestion.similar_images && Array.isArray(topSuggestion.similar_images)) {
                        topSuggestion.similar_images.forEach(img => {
                            if (img.url) {
                                diagnosisData.relatedDiseaseImages.push(img.url);
                            }
                        });
                    }
                }
            }
            
            // Final fallback if absolutely nothing was determined
            if (diagnosisData.pestOrDisease === "Unknown Issue" && diagnosisData.recommendations.length === 0) {
                diagnosisData.recommendations.push("Could not identify specific issue. Please try a clearer photo, different angle, or consult an expert.");
            }

            // 4. Store Diagnosis in Realtime Database under crop_logs
            const diagnosisRef = db.ref(`crop_logs/${cropLogId}/diagnoses`).push(); // Generates a unique key
            const diagnosisId = diagnosisRef.key; // Get the generated key

            await diagnosisRef.set(diagnosisData); // Save the diagnosis data

            // 5. NEW: Store a reference to this diagnosis under the user's node
            const userDiagnosisRef = db.ref(`users/${userId}/diagnoses/${diagnosisId}`);
            await userDiagnosisRef.set({
                cropLogId: cropLogId,
                timestamp: admin.database.ServerValue.TIMESTAMP,
                // You could also store a snippet of the diagnosis result here for quick display
                // e.g., 'pestOrDisease': diagnosisData.pestOrDisease
            });
            console.log(`Diagnosis ID ${diagnosisId} added to user ${userId}'s list.`);
            // END NEW

            // 6. Send Response to Flutter App
            return res.status(200).json({ status: 'success', diagnosisId: diagnosisId, cropLogId: cropLogId, diagnosisDetails: diagnosisData });

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
        console.log("Matched GET request to root URL for health check.");
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