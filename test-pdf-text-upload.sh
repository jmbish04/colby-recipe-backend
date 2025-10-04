#!/bin/bash

WORKER_URL="https://colby-recipe-backend.hacolby.workers.dev"
PDF_DIR="./temp_cooking_appliance_pdf"
API_KEY="6502241638" # Replace with your actual API key from .dev.vars

echo "🚀 Testing PDF + Text Upload Functionality"
echo "=========================================="
echo ""

# Function to upload PDF with text file
upload_pdf_with_text() {
    local pdf_file="$1"
    local text_file="$2"
    local nickname="$3"
    
    echo "📄 Uploading $pdf_file with pre-extracted text..."
    
    response=$(curl -s -X POST "$WORKER_URL/api/kitchen/appliances" \
        -H "X-API-Key: $API_KEY" \
        -F "manual_file=@$pdf_file;type=application/pdf" \
        -F "text_file=@$text_file;type=text/plain" \
        -F "nickname=$nickname")
    
    appliance_id=$(echo "$response" | grep -oP '(?<="appliance_id":")[^"]+' | head -1)
    
    if [ -n "$appliance_id" ]; then
        echo "✅ Successfully uploaded $pdf_file, appliance ID: $appliance_id"
        echo "$appliance_id"
    else
        echo "❌ Failed to upload $pdf_file: $response"
        echo ""
    fi
}

# Function to upload text only
upload_text_only() {
    local text_file="$1"
    local nickname="$2"
    
    echo "📝 Uploading text-only: $(basename "$text_file")..."
    
    response=$(curl -s -X POST "$WORKER_URL/api/kitchen/appliances" \
        -H "X-API-Key: $API_KEY" \
        -F "text_file=@$text_file;type=text/plain" \
        -F "nickname=$nickname")
    
    appliance_id=$(echo "$response" | grep -oP '(?<="appliance_id":")[^"]+' | head -1)
    
    if [ -n "$appliance_id" ]; then
        echo "✅ Successfully uploaded $(basename "$text_file"), appliance ID: $appliance_id"
        echo "$appliance_id"
    else
        echo "❌ Failed to upload $(basename "$text_file"): $response"
        echo ""
    fi
}

# Function to check appliance status
check_appliance_status() {
    local appliance_id="$1"
    local appliance_name="$2"
    
    if [ -z "$appliance_id" ]; then
        return
    fi
    
    echo "🔍 Checking status for $appliance_name ($appliance_id)..."
    
    status_response=$(curl -s -X GET "$WORKER_URL/api/kitchen/appliances/$appliance_id/status" \
        -H "X-API-Key: $API_KEY")
    
    status=$(echo "$status_response" | grep -oP '(?<="status":")[^"]+' | head -1)
    echo "📊 Status for $appliance_name: $status"
    
    if [ "$status" = "COMPLETED" ]; then
        # Get full appliance details
        details_response=$(curl -s -X GET "$WORKER_URL/api/kitchen/appliances/$appliance_id" \
            -H "X-API-Key: $API_KEY")
        
        brand=$(echo "$details_response" | grep -oP '(?<="brand":")[^"]*' | head -1)
        model=$(echo "$details_response" | grep -oP '(?<="model":")[^"]*' | head -1)
        processing_status=$(echo "$details_response" | grep -oP '(?<="processingStatus":")[^"]*' | head -1)
        
        echo "📋 $appliance_name Details:"
        echo "   Brand: ${brand:-'Not detected'}"
        echo "   Model: ${model:-'Not detected'}"
        echo "   Processing Status: $processing_status"
    elif [ "$status" = "FAILED" ]; then
        echo "❌ $appliance_name processing failed"
    else
        echo "⏳ $appliance_name is still processing..."
    fi
    echo ""
}

# Main execution
echo "🧪 Test 1: PDF + Text Upload"
echo "-----------------------------"

# Upload first PDF with its text file
pdf_file="$PDF_DIR/A16pOmAPbWL.pdf"
text_file="$PDF_DIR/A16pOmAPbWL.txt"
if [ -f "$pdf_file" ] && [ -f "$text_file" ]; then
    appliance_id_1=$(upload_pdf_with_text "$pdf_file" "$text_file" "Smart Oven with Pre-extracted Text")
fi

echo ""
echo "🧪 Test 2: Text-only Upload"
echo "----------------------------"

# Upload text file only
text_file="$PDF_DIR/npgbc_05.txt"
if [ -f "$text_file" ]; then
    appliance_id_2=$(upload_text_only "$text_file" "Text-only Appliance Test")
fi

echo ""
echo "⏳ Waiting 20 seconds for processing..."
sleep 20

echo ""
echo "🔍 Checking Processing Results"
echo "=============================="

# Check status of uploaded appliances
if [ -n "$appliance_id_1" ]; then
    check_appliance_status "$appliance_id_1" "Smart Oven"
fi

if [ -n "$appliance_id_2" ]; then
    check_appliance_status "$appliance_id_2" "Text-only Appliance"
fi

echo "✅ All tests completed!"
echo ""
echo "📊 Summary:"
echo "- PDF + Text upload: ${appliance_id_1:-'Failed'}"
echo "- Text-only upload: ${appliance_id_2:-'Failed'}"
echo ""
echo "💡 The system now supports:"
echo "   1. PDF upload only (with OCR processing)"
echo "   2. Text upload only (skips OCR)"
echo "   3. PDF + Text upload (uses provided text, skips OCR)"
echo "   4. PDF + URL upload (downloads PDF, then OCR)"
