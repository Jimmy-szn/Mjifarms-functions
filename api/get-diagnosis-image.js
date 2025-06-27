// api/proxy-plant-id-image.js
// Make sure to install node-fetch if you don't have it: npm install node-fetch

import fetch from 'node-fetch'; // For fetching external URLs

// Removed: import { VercelRequest, VercelResponse } from '@vercel/node';
// This line is for TypeScript type definitions and is not needed in plain JavaScript.

export default async function (req, res) {
  // --- Set CORS Headers ---
  // Allow requests from your Flutter app's origin
  // For development (local Flutter app), use '*':
  res.setHeader('Access-Control-Allow-Origin', '*');
  // For production, replace '*' with your specific Flutter web domain(s) for security:
  // res.setHeader('Access-Control-Allow-Origin', 'https://your-flutter-app.web.app');
  // You can list multiple origins:
  // res.setHeader('Access-Control-Allow-Origin', 'https://your-flutter-app.web.app, https://www.your-custom-domain.com');

  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Include any custom headers your client might send
  res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight requests for 24 hours

  // Handle preflight OPTIONS request (important for CORS)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // --- Get the original Plant.ID image URL from query parameters ---
  const plantIdImageUrl = req.query.url; // Expecting ?url=https://images.plant.id/...

  if (!plantIdImageUrl) {
    return res.status(400).send('Missing "url" query parameter for the image.');
  }

  try {
    // --- Fetch the image from Plant.ID ---
    const response = await fetch(plantIdImageUrl);

    if (!response.ok) {
      // If Plant.ID returns an error (e.g., 404, 500)
      console.error(`Failed to fetch image from Plant.ID: ${response.status} ${response.statusText}`);
      return res.status(response.status).send(`Failed to fetch image from Plant.ID: ${response.statusText}`);
    }

    // --- Determine Content-Type and send image data ---
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType); // Set the correct content type (e.g., image/jpeg, image/png)

    // Stream the image data directly to the client
    response.body.pipe(res);

  } catch (error) {
    console.error('Error proxying image:', error);
    res.status(500).send('Internal server error while proxying image.');
  }
}