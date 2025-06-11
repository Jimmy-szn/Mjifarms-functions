const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios"); // For making HTTP requests

admin.initializeApp();
const db = admin.firestore();

exports.diagnosePlant = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Unauthenticated.");
  }

  const imageUrl = data.imageUrl;
  const cropLogId = data.cropLogId;
  const plantId = data.plantId;

  if (!imageUrl || !cropLogId || !plantId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing details");
  }

  const PLANTID_API_KEY = functions.config().plantid.key;
  const PLANTID_ENDPOINT = "https://api.plant.id/v3";

  try {
    const response = await axios.post(PLANTID_ENDPOINT, {
      api_key: PLANTID_API_KEY,
      images: [imageUrl],
      organs: ["leaf", "stem", "flower", "fruit"],
      disease_details: true,
    }, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    const apiResponse = response.data;
    console.log("Plant.id API Response:", JSON.stringify(apiResponse, null, 2));


    const diagnosisData = {
      date: admin.firestore.FieldValue.serverTimestamp(),
      originalImageURL: imageUrl,
      source: "AI_Plant.id",
      confidenceLevel: 0,
      pestOrDisease: "Unknown Issue",
      recommendations: [],
      rawApiResponse: apiResponse,
    };

    if (apiResponse.is_healthy && apiResponse.is_healthy.binary) {
      if (apiResponse.is_healthy.binary === "healthy") {
        diagnosisData.pestOrDisease = "Healthy";
        diagnosisData.confidenceLevel = apiResponse.is_healthy.probability;
        diagnosisData.recommendations.push("Plant appears healthy!");
      } else if (apiResponse.is_healthy.binary === "unhealthy") {
        diagnosisData.pestOrDisease = "Unhealthy - Specific issue pending";
        diagnosisData.confidenceLevel = apiResponse.is_healthy.probability || 0;
      }
    }

    // Detailed disease information from health_assessment.diseases
    if (apiResponse.health_assessment.diseases.length > 0) {
      const topDisease = apiResponse.health_assessment.diseases[0];
      diagnosisData.pestOrDisease = topDisease.name;
      diagnosisData.confidenceLevel = topDisease.probability;
      if (topDisease.suggestions && topDisease.suggestions.length > 0) {
        diagnosisData.recommendations =
         topDisease.suggestions.map((s) => s.name);
      }
    } else if (apiResponse.suggestions.length > 0 &&
         diagnosisData.pestOrDisease === "Unknown Issue") {
      const topSuggestion = apiResponse.suggestions[0];
      diagnosisData.pestOrDisease = `Identified as: 
        ${topSuggestion.plant_name}`;
      diagnosisData.confidenceLevel = topSuggestion.probability;
      diagnosisData.recommendations.push("Plant identified as " +
        topSuggestion.plant_name + ".");
    }


    if ( diagnosisData.recommendations.length === 0) {
      diagnosisData.recommendations.push("Could not identify specific issue.");
    }

    const diagnosisRef = db.collection("crop_logs")
        .doc(cropLogId).collection("diagnoses").add(diagnosisData);
    const diagnosisId = (await diagnosisRef).id;

    return {status: "success", diagnosisId: diagnosisId,
      diagnosisDetails: diagnosisData};
  } catch (error) {
    console.error("Error during Plant.id API call or Firestore write:", error);
    if (error.response) {
      console.error("Plant.id API Error Response (Status:",
          error.response.status, "):", error.response.data);
      throw new functions.https.HttpsError("internal",
          `Plant.id API error:${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error("Plant.id API No Response:", error.request);
      throw new functions.https.HttpsError("unavailable",
          "No response received from Plant.id API.");
    } else {
      console.error("Error setting up Plant.id API request:", error.message);
      throw new functions.https.HttpsError("internal",
          `Failed to diagnose plant: ${error.message}`);
    }
  }
});
