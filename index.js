// index.js

const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase Admin SDK using environment variable
const serviceAccountBaseBase66 = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountBaseBase66) {
  console.error("FIREBASE_SERVICE_ACCOUNT environment variable is not set. Please set it in Vercel project settings.");
  module.exports = (req, res) => res.status(500).json({ status: 'error', message: 'Server configuration error: Firebase credentials missing.' });
  return;
}

let serviceAccount;
try {
    serviceAccount = JSON.parse(Buffer.from(serviceAccountBaseBase66, 'base64').toString('utf8'));
} catch (e) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT:", e);
    module.exports = (req, res) => res.status(500).json({ status: 'error', message: 'Server configuration error: Invalid Firebase credentials format.' });
    return;
}

// Initialize Firebase Admin SDK only once
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}
const db = admin.firestore();

const PLANTID_API_KEY = process.env.PLANTID_API_KEY;

// Main handler for all incoming requests
module.exports = async (req, res) => {
    // --- CORS HEADERS ARE NOW HANDLED BY vercel.json ---
    // The previous CORS logic (setting headers and handling OPTIONS method)
    // has been moved to vercel.json for project-level control.
    // This function will only process actual requests (GET, POST).


    // Check if the Plant.id API key is configured
    if (!PLANTID_API_KEY) {
        console.error("PLANTID_API_KEY is not configured in Vercel environment variables.");
        return res.status(500).json({ status: 'error', message: 'Server Error: Plant.id API Key not configured.' });
    }

    // Route requests based on URL path
    if (req.url === '/' && req.method === 'POST') {
        // ... (rest of your diagnosePlant logic remains the same) ...

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

        const { base64Image, cropLogId, plantId } = req.body; // Expecting base64Image now

        if (!base64Image || !cropLogId || !plantId) {
            return res.status(400).json({ message: 'Bad Request: Missing base64Image, cropLogId, or plantId.' });
        }

        const PLANTID_ENDPOINT = 'https://api.plant.id/v2/health_assessment';

        try {
            // 2. Make API Call to Plant.id with Base64 image
            const apiCallResponse = await axios.post(PLANTID_ENDPOINT, {
                api_key: PLANTID_API_KEY,
                images: [base64Image], // Sending Base64 string directly
                organs: ['leaf', 'stem', 'flower', 'fruit'],
                disease_details: true
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const apiResponse = apiCallResponse.data;
            console.log('Plant.id API Response:', JSON.stringify(apiResponse, null, 2));

            // 3. Process API Response and Extract Diagnosis Data
            const diagnosisData = {
                date: admin.firestore.FieldValue.serverTimestamp(),
                // originalImageURL: imageUrl, // No direct URL if not stored in Firebase Storage
                source: "AI_Plant.id",
                confidenceLevel: 0,
                pestOrDisease: "Unknown Issue",
                recommendations: [],
                rawApiResponse: apiResponse // Store raw response for debugging/future analysis
            };

            if (apiResponse.is_healthy && apiResponse.is_healthy.binary) {
                if (apiResponse.is_healthy.binary === 'healthy') {
                    diagnosisData.pestOrDisease = "Healthy";
                    diagnosisData.confidenceLevel = apiResponse.is_healthy.probability || 1.0;
                    diagnosisData.recommendations.push("Your plant appears healthy!");
                } else if (apiResponse.is_healthy.binary === 'unhealthy') {
                    diagnosisData.pestOrDisease = "Unhealthy - Specific issue pending analysis.";
                    diagnosisData.confidenceLevel = apiResponse.is_healthy.probability || 0;
                }
            }
            
            if (apiResponse.health_assessment && apiResponse.health_assessment.diseases && apiResponse.health_assessment.diseases.length > 0) {
                const topDisease = apiResponse.health_assessment.diseases[0];
                diagnosisData.pestOrDisease = topDisease.name;
                diagnosisData.confidenceLevel = topDisease.probability;
                if (topDisease.suggestions && apiResponse.suggestions.length > 0) {
                    diagnosisData.recommendations = topDisease.suggestions.map((s) => s.name);
                }
            } else if (apiResponse.suggestions && apiResponse.suggestions.length > 0 && diagnosisData.pestOrDisease === "Unknown Issue") {
                const topSuggestion = apiResponse.suggestions[0];
                diagnosisData.pestOrDisease = `Identified as: ${topSuggestion.plant_name}`;
                diagnosisData.confidenceLevel = topSuggestion.probability;
                diagnosisData.recommendations.push("No specific health issue detected, but the plant is identified as " + topSuggestion.plant_name + ".");
            }
            
            if (diagnosisData.pestOrDisease === "Unknown Issue" && diagnosisData.recommendations.length === 0) {
                 diagnosisData.recommendations.push("Could not identify specific issue. Please try a clearer photo, different angle, or consult an expert.");
            }

            // 4. Store Diagnosis in Firestore
            const diagnosisRef = await db.collection('crop_logs').doc(cropLogId).collection('diagnoses').add(diagnosisData);
            const diagnosisId = diagnosisRef.id;

            // 5. Send Response to Flutter App
            return res.status(200).json({ status: 'success', diagnosisId: diagnosisId, diagnosisDetails: diagnosisData });

        } catch (error) {
            console.error("Error during Plant.id API call or Firestore write:", error);
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
    } else if (req.url === '/' && req.method === 'GET') {
        // --- Default /api endpoint (Health Check) ---
        res.status(200).json({
            message: 'Welcome to the Urban Farming Assistant App API!',
            endpoint: req.url,
            method: req.method,
            status: 'ready'
        });
    } else {
        // --- Handle other/unsupported routes ---
        res.status(404).json({ message: 'Not Found', endpoint: req.url, method: req.method });
    }
};
