#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const WORKER_URL = 'https://colby-recipe-backend.hacolby.workers.dev';
const PDF_DIR = './temp_cooking_appliance_pdf';

// Test user ID - we'll use a consistent test user
const TEST_USER_ID = 'test-user-' + Date.now();

// API Key from environment or use the dev key
const API_KEY = process.env.WORKER_API_KEY || '6502241638';

async function createTestSession() {
  console.log('Creating test session...');
  
  // Let's try to create a user session by calling the prefs endpoint
  // This might create a user if one doesn't exist
  try {
    const response = await fetch(`${WORKER_URL}/api/prefs`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'Authorization': `Bearer test-session-${Date.now()}`
      },
      body: JSON.stringify({
        userId: TEST_USER_ID,
        cuisines: 'test',
        dislikedIngredients: [],
        favoredTools: 'test'
      }),
    });
    
    console.log('Prefs response:', response.status, await response.text());
    
    // Generate a session token
    const sessionToken = 'test-session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    console.log(`Generated test session token: ${sessionToken}`);
    
    return sessionToken;
  } catch (error) {
    console.log('Error creating session:', error.message);
    return null;
  }
}

async function createUserSession() {
  console.log('Attempting to create user session...');
  
  // Try to create a user by calling the prefs endpoint with a valid session
  const sessionToken = 'test-session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  try {
    // First, let's try to create a user by calling the prefs endpoint
    const response = await fetch(`${WORKER_URL}/api/prefs`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify({
        userId: TEST_USER_ID,
        cuisines: 'test',
        dislikedIngredients: [],
        favoredTools: 'test'
      }),
    });
    
    console.log('Prefs response:', response.status, await response.text());
    
    // If that worked, we need to create a session in KV
    // Since we can't directly access KV, let's try a different approach
    // Let's try to use the session token we generated
    
    return sessionToken;
  } catch (error) {
    console.log('Error creating user session:', error.message);
    return null;
  }
}

async function uploadPDF(filename) {
  const filePath = path.join(PDF_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return null;
  }

  console.log(`Uploading ${filename}...`);
  
  // Read the file as a buffer
  const fileBuffer = fs.readFileSync(filePath);
  
  // Create FormData using the form-data library with buffer
  const form = new FormData();
  form.append('manual_file', fileBuffer, {
    filename: filename,
    contentType: 'application/pdf'
  });
  form.append('nickname', `Test Appliance ${filename.replace('.pdf', '')}`);

  const headers = {
    'X-API-Key': API_KEY,
    ...form.getHeaders()
  };

  try {
    const response = await fetch(`${WORKER_URL}/api/kitchen/appliances`, {
      method: 'POST',
      headers: headers,
      body: form
    });

    const responseText = await response.text();
    console.log(`Response for ${filename}:`, response.status, responseText);

    if (response.ok) {
      const data = JSON.parse(responseText);
      console.log(`✅ Successfully uploaded ${filename}, appliance ID: ${data.appliance?.id}`);
      return data.appliance?.id;
    } else {
      console.error(`❌ Failed to upload ${filename}:`, response.status, responseText);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error uploading ${filename}:`, error.message);
    return null;
  }
}

async function checkApplianceStatus(applianceId) {
  if (!applianceId) return;

  console.log(`Checking status for appliance ${applianceId}...`);
  
  const headers = {
    'X-API-Key': API_KEY,
  };

  try {
    const response = await fetch(`${WORKER_URL}/api/kitchen/appliances/${applianceId}/status`, {
      method: 'GET',
      headers: headers
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`Status for ${applianceId}:`, data);
      return data;
    } else {
      console.log(`Could not get status for ${applianceId}:`, response.status);
      return null;
    }
  } catch (error) {
    console.error(`Error checking status for ${applianceId}:`, error.message);
    return null;
  }
}

async function listAppliances() {
  console.log('Listing all appliances...');
  
  const headers = {
    'X-API-Key': API_KEY,
  };

  try {
    const response = await fetch(`${WORKER_URL}/api/kitchen/appliances`, {
      method: 'GET',
      headers: headers
    });

    if (response.ok) {
      const data = await response.json();
      console.log('All appliances:', JSON.stringify(data, null, 2));
      return data.appliances || [];
    } else {
      console.log('Could not list appliances:', response.status);
      return [];
    }
  } catch (error) {
    console.error('Error listing appliances:', error.message);
    return [];
  }
}

async function main() {
  console.log('🚀 Starting PDF upload test to live deployment');
  console.log(`Target URL: ${WORKER_URL}`);
  console.log(`PDF Directory: ${PDF_DIR}`);
  console.log(`Test User ID: ${TEST_USER_ID}`);
  console.log('');

  // Check if PDF directory exists
  if (!fs.existsSync(PDF_DIR)) {
    console.error(`❌ PDF directory not found: ${PDF_DIR}`);
    process.exit(1);
  }

  // Get list of PDF files
  const pdfFiles = fs.readdirSync(PDF_DIR).filter(file => file.endsWith('.pdf'));
  console.log(`Found ${pdfFiles.length} PDF files:`, pdfFiles);
  console.log('');

  if (pdfFiles.length === 0) {
    console.error('❌ No PDF files found in directory');
    process.exit(1);
  }

  // Upload each PDF (no user authentication required for admin task)
  const applianceIds = [];
  for (const filename of pdfFiles) { // Upload all files
    const applianceId = await uploadPDF(filename);
    if (applianceId) {
      applianceIds.push(applianceId);
    }
    console.log(''); // Add spacing between uploads
  }

  console.log(`📊 Upload Summary:`);
  console.log(`- Total PDFs: ${pdfFiles.length}`);
  console.log(`- Successful uploads: ${applianceIds.length}`);
  console.log(`- Appliance IDs: ${applianceIds.join(', ')}`);
  console.log('');

  // Wait a moment for processing to start
  console.log('⏳ Waiting 5 seconds for processing to start...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check status of each appliance
  for (const applianceId of applianceIds) {
    await checkApplianceStatus(applianceId);
  }

  console.log('');

  // List all appliances
  await listAppliances();

  console.log('');
  console.log('✅ Test completed!');
}

// Run the test
main().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
