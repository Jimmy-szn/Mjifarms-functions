const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase Admin SDK
// This assumes your project is properly linked and you have Firebase CLI installed.
// The functions environment will automatically pick up your Firebase project ID.
if (!admin.apps.length) {
    admin.initializeApp({
        // IMPORTANT: Replace with your Firebase Realtime Database URL
        // Example: "https://YOUR-FIREBASE-PROJECT-ID-default-rtdb.firebaseio.com"
        databaseURL: "https://mjifarms-assistant-app-default-rtdb.firebaseio.com" // Placeholder, replace with your actual URL
    });
}
const db = admin.database(); // Get Realtime Database instance

// Configure Plant.id API key as an environment variable for Cloud Functions
// Run: firebase functions:config:set plantid.key="YOUR_PLANTID_API_KEY"
// In your terminal from the 'functions' directory or project root.
const PLANTID_API_KEY = functions.config().plantid?.key;

// Define the Callable HTTP Cloud Function
// Explicitly specify the region for the function to avoid Blaze requirement for external egress
// when making API calls. 'us-central1' allows external network requests on the Spark plan.
exports.diagnosePlant = functions.region('us-central1').https.onCall(async (data, context) => { // ADDED .region('us-central1')
    // 1. Authenticate User automatically via context.auth
    if (!context.auth) {
        // This is automatically handled by HttpsCallable, but good to keep explicit.
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    // Access data directly from the 'data' argument for onCall functions
    const base64Image = data.base64Image; // Changed to base64Image directly
    const cropLogId = data.cropLogId;
    const plantId = data.plantId;
    const userId = context.auth.uid; // User ID is automatically available from authenticated context
    // You can also get latitude and longitude if sent from Flutter
    const latitude = data.latitude;
    const longitude = data.longitude;


    // Check if the Plant.id API key is configured
    if (!PLANTID_API_KEY) {
        console.error("PLANTID_API_KEY is not configured in Cloud Functions environment variables.");
        throw new functions.https.HttpsError('internal', 'Server Error: Plant.id API Key not configured.');
    }

    console.log(`Incoming Callable Function Request from User ${userId}:`);
    console.log(`cropLogId: ${cropLogId}, plantId: ${plantId}, image data present: ${base64Image ? 'Yes' : 'No'}`);

    if (!base64Image || !cropLogId || !plantId) {
        console.error("Bad Request: Missing base64Image, cropLogId, or plantId.");
        throw new functions.https.HttpsError('invalid-argument', 'Missing base64Image, cropLogId, or plantId.');
    }

    // Plant.id API Endpoint and parameters based on official documentation
    const PLANTID_ENDPOINT = 'https://plant.id/api/v3/health_assessment'; 

    try {
        // 2. Make API Call to Plant.id with Base64 image
        const apiCallResponse = await axios.post(PLANTID_ENDPOINT, {
            api_key: PLANTID_API_KEY,
            images: [base64Image], // Sending Base64 string directly
            organs: ['leaf', 'stem', 'flower', 'fruit'], // Specify organs relevant to plant health
            disease_details: true, // Request detailed information as per API docs
            similar_images: true, // IMPORTANT: Request similar images
            // Include location if available
            latitude: latitude,
            longitude: longitude
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const apiResponse = apiCallResponse.data;
        console.log('Plant.id API Response:', JSON.stringify(apiResponse, null, 2));

        // 3. Process API Response and Extract Diagnosis Data
        const diagnosisData = {
            userId: userId, // Link diagnosis to the user who made the request
            date: admin.database.ServerValue.TIMESTAMP, // Use Realtime Database server timestamp
            source: "AI_Plant.id",
            confidenceLevel: 0,
            pestOrDisease: "Unknown Issue",
            recommendations: [],
            relatedDiseaseImages: [], // Initialize list for similar images
            rawApiResponse: apiResponse // Store raw response for debugging/future analysis
        };

        if (apiResponse.is_healthy && typeof apiResponse.is_healthy.binary !== 'undefined') {
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

            // Extract recommendations (suggestions from the top disease)
            if (topDisease.suggestions && topDisease.suggestions.length > 0) {
                // You might refine this to pick descriptions/treatments if available in 'details'
                diagnosisData.recommendations = topDisease.suggestions.map((s) => s.name);
            }
            // Extract similar images for the top disease
            if (topDisease.similar_images && topDisease.similar_images.length > 0) {
                diagnosisData.relatedDiseaseImages = topDisease.similar_images.map(img => img.url);
            }

            // Extracting additional details if available from the API response
            if (topDisease.details) {
                if (topDisease.details.description) diagnosisData.description = topDisease.details.description.value;
                if (topDisease.details.treatment) {
                    if (Array.isArray(topDisease.details.treatment)) {
                        // Assuming treatment is an array of strings or objects with 'value'
                        diagnosisData.treatment = topDisease.details.treatment.map(t => typeof t === 'object' && t.value ? t.value : t);
                    } else if (typeof topDisease.details.treatment === 'object' && topDisease.details.treatment.api_name) {
                        diagnosisData.treatment = topDisease.details.treatment.api_name;
                    } else {
                        diagnosisData.treatment = topDisease.details.treatment;
                    }
                }
                if (topDisease.details.classification) diagnosisData.classification = topDisease.details.classification.taxonomy;
                if (topDisease.details.cause) diagnosisData.cause = topDisease.details.cause.name;
            }

        } else if (apiResponse.suggestions && apiResponse.suggestions.length > 0 && diagnosisData.pestOrDisease === "Unknown Issue") {
            // Fallback: If health assessment is not explicit, use general plant identification suggestions if available
            const topSuggestion = apiResponse.suggestions[0];
            diagnosisData.pestOrDisease = `Identified as: ${topSuggestion.plant_name}`;
            diagnosisData.confidenceLevel = topSuggestion.probability;
            diagnosisData.recommendations.push("No specific health issue detected, but the plant is identified as " + topSuggestion.plant_name + ".");
            // Also extract similar images if available from general identification
            if (topSuggestion.similar_images && topSuggestion.similar_images.length > 0) {
                diagnosisData.relatedDiseaseImages = topSuggestion.similar_images.map(img => img.url);
            }
        }
        
        if (diagnosisData.pestOrDisease === "Unknown Issue" && diagnosisData.recommendations.length === 0) {
             diagnosisData.recommendations.push("Could not identify specific issue. Please try a clearer photo, different angle, or consult an expert.");
        }

        // 4. Store Diagnosis in Realtime Database
        // Structure: /crop_logs/{cropLogId}/diagnoses/{diagnosisId}
        const diagnosisRef = db.ref(`crop_logs/${cropLogId}/diagnoses`).push();
        const diagnosisId = diagnosisRef.key;

        await diagnosisRef.set(diagnosisData);

        // 5. Return success status and diagnosis ID to Flutter App
        return { status: 'success', diagnosisId: diagnosisId, diagnosisDetails: diagnosisData };

    } catch (error) {
        console.error("Error during Plant.id API call or Realtime Database write:", error);
        if (error.response) {
            console.error("Plant.id API Error Response (Status:", error.response.status, "):", error.response.data);
            throw new functions.https.HttpsError('internal', `Plant.id API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            console.error("Plant.id API No Response:", error.request);
            throw new functions.https.HttpsError('unavailable', 'No response received from Plant.id API.');
        } else {
            console.error("Error setting up Plant.id API request:", error.message);
            throw new functions.https.HttpsError('internal', `Failed to diagnose plant: ${error.message}`);
        }
    }
});
