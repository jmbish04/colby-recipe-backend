#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const WORKER_URL = 'https://colby-recipe-backend.hacolby.workers.dev';
const API_KEY = '6502241638'; // From .dev.vars
const PDF_DIR = './temp_cooking_appliance_pdf';

async function uploadPDFWithText(pdfFilename) {
  const pdfPath = path.join(PDF_DIR, pdfFilename);
  const textPath = path.join(PDF_DIR, pdfFilename.replace('.pdf', '.txt'));
  
  if (!fs.existsSync(pdfPath)) {
    console.error(`❌ PDF file not found: ${pdfPath}`);
    return null;
  }
  
  if (!fs.existsSync(textPath)) {
    console.error(`❌ Text file not found: ${textPath}`);
    return null;
  }

  console.log(`📄 Uploading ${pdfFilename} with pre-extracted text...`);
  
  const form = new FormData();
  form.append('manual_file', fs.createReadStream(pdfPath), {
    filename: pdfFilename,
    contentType: 'application/pdf'
  });
  form.append('text_file', fs.createReadStream(textPath), {
    filename: pdfFilename.replace('.pdf', '.txt'),
    contentType: 'text/plain'
  });
  form.append('nickname', `Smart Appliance ${pdfFilename.replace('.pdf', '')}`);

  try {
    const response = await fetch(`${WORKER_URL}/api/kitchen/appliances`, {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        ...form.getHeaders()
      },
      body: form
    });

    const result = await response.json();
    if (result.appliance_id) {
      console.log(`✅ Successfully uploaded ${pdfFilename}, appliance ID: ${result.appliance_id}`);
      return result.appliance_id;
    } else {
      console.error(`❌ Failed to upload ${pdfFilename}:`, result);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error uploading ${pdfFilename}:`, error.message);
    return null;
  }
}

async function uploadTextOnly(textFilename) {
  const textPath = path.join(PDF_DIR, textFilename);
  
  if (!fs.existsSync(textPath)) {
    console.error(`❌ Text file not found: ${textPath}`);
    return null;
  }

  console.log(`📝 Uploading text-only: ${textFilename}...`);
  
  const form = new FormData();
  form.append('text_file', fs.createReadStream(textPath), {
    filename: textFilename,
    contentType: 'text/plain'
  });
  form.append('nickname', `Text-only Appliance ${textFilename.replace('.txt', '')}`);

  try {
    const response = await fetch(`${WORKER_URL}/api/kitchen/appliances`, {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        ...form.getHeaders()
      },
      body: form
    });

    const result = await response.json();
    if (result.appliance_id) {
      console.log(`✅ Successfully uploaded ${textFilename}, appliance ID: ${result.appliance_id}`);
      return result.appliance_id;
    } else {
      console.error(`❌ Failed to upload ${textFilename}:`, result);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error uploading ${textFilename}:`, error.message);
    return null;
  }
}

async function checkApplianceStatus(applianceId, applianceName) {
  if (!applianceId) return;
  
  console.log(`🔍 Checking status for ${applianceName} (${applianceId})...`);
  
  try {
    const response = await fetch(`${WORKER_URL}/api/kitchen/appliances/${applianceId}/status`, {
      headers: {
        'X-API-Key': API_KEY
      }
    });
    
    const status = await response.json();
    console.log(`📊 Status for ${applianceName}: ${status.status}`);
    
    if (status.status === 'COMPLETED') {
      // Get full appliance details
      const detailsResponse = await fetch(`${WORKER_URL}/api/kitchen/appliances/${applianceId}`, {
        headers: {
          'X-API-Key': API_KEY
        }
      });
      
      const details = await detailsResponse.json();
      console.log(`📋 ${applianceName} Details:`);
      console.log(`   Brand: ${details.appliance.brand || 'Not detected'}`);
      console.log(`   Model: ${details.appliance.model || 'Not detected'}`);
      console.log(`   Features: ${details.appliance.extractedSpecs?.keyFeatures?.slice(0, 3).join(', ') || 'None'}${details.appliance.extractedSpecs?.keyFeatures?.length > 3 ? '...' : ''}`);
      console.log(`   Processing Status: ${details.appliance.processingStatus}`);
      console.log(`   Vector Chunks: ${details.appliance.extractedSpecs?.vectorChunkCount || 0}`);
    } else if (status.status === 'FAILED') {
      console.log(`❌ ${applianceName} processing failed`);
    } else {
      console.log(`⏳ ${applianceName} is still processing...`);
    }
  } catch (error) {
    console.error(`❌ Status check failed for ${applianceName}:`, error.message);
  }
}

async function main() {
  console.log('🚀 Testing PDF + Text Upload with Real Files');
  console.log('=============================================\n');

  // Get all PDF files
  const pdfFiles = fs.readdirSync(PDF_DIR).filter(file => file.endsWith('.pdf'));
  const textFiles = fs.readdirSync(PDF_DIR).filter(file => file.endsWith('.txt'));
  
  console.log(`Found ${pdfFiles.length} PDF files and ${textFiles.length} text files`);
  console.log('PDF files:', pdfFiles.join(', '));
  console.log('Text files:', textFiles.join(', '));
  console.log('');

  const applianceIds = [];

  // Test 1: Upload PDF with corresponding text file
  console.log('🧪 Test 1: PDF + Text Upload');
  console.log('-----------------------------');
  for (const pdfFile of pdfFiles.slice(0, 2)) { // Test first 2 files
    const applianceId = await uploadPDFWithText(pdfFile);
    if (applianceId) {
      applianceIds.push({ id: applianceId, name: pdfFile });
    }
    console.log(''); // Add spacing
  }

  // Test 2: Upload text-only
  console.log('🧪 Test 2: Text-only Upload');
  console.log('----------------------------');
  for (const textFile of textFiles.slice(0, 1)) { // Test first text file
    const applianceId = await uploadTextOnly(textFile);
    if (applianceId) {
      applianceIds.push({ id: applianceId, name: textFile });
    }
    console.log(''); // Add spacing
  }

  // Wait for processing
  console.log('⏳ Waiting 15 seconds for processing...');
  await new Promise(resolve => setTimeout(resolve, 15000));

  // Check status of all appliances
  console.log('🔍 Checking Processing Results');
  console.log('==============================');
  for (const appliance of applianceIds) {
    await checkApplianceStatus(appliance.id, appliance.name);
    console.log(''); // Add spacing
  }

  console.log('✅ All tests completed!');
  console.log(`📊 Processed ${applianceIds.length} appliances`);
}

main().catch(console.error);
