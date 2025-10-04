#!/bin/bash

# PDF Upload Script for Colby Recipe Backend
# This script uploads all PDF files from the temp_cooking_appliance_pdf directory

WORKER_URL="https://colby-recipe-backend.hacolby.workers.dev"
API_KEY="6502241638"
PDF_DIR="./temp_cooking_appliance_pdf"

echo "🚀 Starting PDF upload to live deployment"
echo "Target URL: $WORKER_URL"
echo "PDF Directory: $PDF_DIR"
echo ""

# Check if PDF directory exists
if [ ! -d "$PDF_DIR" ]; then
    echo "❌ PDF directory not found: $PDF_DIR"
    exit 1
fi

# Get list of PDF files
pdf_files=($(find "$PDF_DIR" -name "*.pdf" -type f))
echo "Found ${#pdf_files[@]} PDF files:"
for file in "${pdf_files[@]}"; do
    echo "  - $(basename "$file")"
done
echo ""

if [ ${#pdf_files[@]} -eq 0 ]; then
    echo "❌ No PDF files found in directory"
    exit 1
fi

# Upload each PDF
appliance_ids=()
successful_uploads=0

for pdf_file in "${pdf_files[@]}"; do
    filename=$(basename "$pdf_file")
    nickname="Test Appliance ${filename%.pdf}"
    
    echo "Uploading $filename..."
    
    response=$(curl -s -X POST "$WORKER_URL/api/kitchen/appliances" \
        -H "X-API-Key: $API_KEY" \
        -F "manual_file=@$pdf_file" \
        -F "nickname=$nickname")
    
    if echo "$response" | grep -q '"appliance_id"'; then
        appliance_id=$(echo "$response" | grep -o '"appliance_id":"[^"]*"' | cut -d'"' -f4)
        echo "✅ Successfully uploaded $filename, appliance ID: $appliance_id"
        appliance_ids+=("$appliance_id")
        ((successful_uploads++))
    else
        echo "❌ Failed to upload $filename: $response"
    fi
    echo ""
done

echo "📊 Upload Summary:"
echo "- Total PDFs: ${#pdf_files[@]}"
echo "- Successful uploads: $successful_uploads"
echo "- Appliance IDs: ${appliance_ids[*]}"
echo ""

# Wait a moment for processing to start
echo "⏳ Waiting 5 seconds for processing to start..."
sleep 5

# Check status of each appliance
echo "Checking appliance statuses..."
for appliance_id in "${appliance_ids[@]}"; do
    echo "Checking status for appliance $appliance_id..."
    status_response=$(curl -s -X GET "$WORKER_URL/api/kitchen/appliances/$appliance_id/status" \
        -H "X-API-Key: $API_KEY")
    echo "Status: $status_response"
    echo ""
done

# List all appliances
echo "Listing all appliances..."
all_appliances=$(curl -s -X GET "$WORKER_URL/api/kitchen/appliances" \
    -H "X-API-Key: $API_KEY")
echo "All appliances: $all_appliances"
echo ""

echo "✅ Upload test completed!"
