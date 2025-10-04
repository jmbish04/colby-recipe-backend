#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const WORKER_URL = 'https://colby-recipe-backend.hacolby.workers.dev';
const API_KEY = '6502241638'; // From .dev.vars

async function uploadWithTextOnly() {
  console.log('🧪 Testing text-only upload...');
  
  const text = `This is a comprehensive manual for a Smart Coffee Maker Pro.
  
Brand: CoffeeTech
Model: SCM-3000
Capacity: 12 cups
Wattage: 1200W

Key Features:
- Programmable brewing
- Grind and brew functionality
- Keep warm feature
- Auto shut-off
- Water filtration system
- Multiple brew strength options

The CoffeeTech SCM-3000 is designed for coffee enthusiasts who want precision and convenience in their daily brewing routine.`;

  const form = new FormData();
  form.append('text', text);
  form.append('nickname', 'Smart Coffee Maker Pro');

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
    console.log('✅ Text-only upload result:', result);
    return result.appliance_id;
  } catch (error) {
    console.error('❌ Text-only upload failed:', error.message);
    return null;
  }
}

async function uploadWithPDFAndText() {
  console.log('🧪 Testing PDF + text upload...');
  
  const pdfPath = path.join(__dirname, 'temp_cooking_appliance_pdf', 'npgbc_05.pdf');
  const text = `This is a manual for a Professional Blender.
  
Brand: BlendMaster
Model: PB-5000
Capacity: 2.5 liters
Wattage: 1500W

Key Features:
- High-speed motor
- Multiple speed settings
- Pulse function
- BPA-free container
- Easy-clean design
- Safety lock system

The BlendMaster PB-5000 is perfect for smoothies, soups, and food preparation.`;

  if (!fs.existsSync(pdfPath)) {
    console.error('❌ PDF file not found:', pdfPath);
    return null;
  }

  const form = new FormData();
  form.append('manual_file', fs.createReadStream(pdfPath), {
    filename: 'npgbc_05.pdf',
    contentType: 'application/pdf'
  });
  form.append('text', text);
  form.append('nickname', 'Professional Blender with PDF');

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
    console.log('✅ PDF + text upload result:', result);
    return result.appliance_id;
  } catch (error) {
    console.error('❌ PDF + text upload failed:', error.message);
    return null;
  }
}

async function uploadWithTextFile() {
  console.log('🧪 Testing text file upload...');
  
  // Create a temporary text file
  const textContent = `This is a manual for a Digital Food Scale.

Brand: ScaleTech
Model: DFS-2000
Capacity: 5kg
Precision: 1g

Key Features:
- Digital display
- Tare function
- Multiple units (g, oz, lb, kg)
- Auto-off
- Stainless steel platform
- Easy to clean

The ScaleTech DFS-2000 provides accurate measurements for all your cooking needs.`;

  const textFilePath = path.join(__dirname, 'temp_scale_manual.txt');
  fs.writeFileSync(textFilePath, textContent);

  const form = new FormData();
  form.append('text_file', fs.createReadStream(textFilePath), {
    filename: 'scale_manual.txt',
    contentType: 'text/plain'
  });
  form.append('nickname', 'Digital Food Scale');

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
    console.log('✅ Text file upload result:', result);
    
    // Clean up temp file
    fs.unlinkSync(textFilePath);
    
    return result.appliance_id;
  } catch (error) {
    console.error('❌ Text file upload failed:', error.message);
    // Clean up temp file
    if (fs.existsSync(textFilePath)) {
      fs.unlinkSync(textFilePath);
    }
    return null;
  }
}

async function checkApplianceStatus(applianceId) {
  if (!applianceId) return;
  
  console.log(`🔍 Checking status for appliance ${applianceId}...`);
  
  try {
    const response = await fetch(`${WORKER_URL}/api/kitchen/appliances/${applianceId}/status`, {
      headers: {
        'X-API-Key': API_KEY
      }
    });
    
    const status = await response.json();
    console.log('📊 Status:', status);
    
    if (status.status === 'COMPLETED') {
      // Get full appliance details
      const detailsResponse = await fetch(`${WORKER_URL}/api/kitchen/appliances/${applianceId}`, {
        headers: {
          'X-API-Key': API_KEY
        }
      });
      
      const details = await detailsResponse.json();
      console.log('📋 Appliance Details:');
      console.log(`   Brand: ${details.appliance.brand}`);
      console.log(`   Model: ${details.appliance.model}`);
      console.log(`   Features: ${details.appliance.extractedSpecs?.keyFeatures?.join(', ') || 'None'}`);
      console.log(`   Processing Status: ${details.appliance.processingStatus}`);
    }
  } catch (error) {
    console.error('❌ Status check failed:', error.message);
  }
}

async function main() {
  console.log('🚀 Testing PDF + Text Upload Functionality');
  console.log('==========================================\n');

  // Test 1: Text only
  const textOnlyId = await uploadWithTextOnly();
  if (textOnlyId) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    await checkApplianceStatus(textOnlyId);
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 2: PDF + Text
  const pdfTextId = await uploadWithPDFAndText();
  if (pdfTextId) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    await checkApplianceStatus(pdfTextId);
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 3: Text file
  const textFileId = await uploadWithTextFile();
  if (textFileId) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    await checkApplianceStatus(textFileId);
  }

  console.log('\n✅ All tests completed!');
}

main().catch(console.error);
