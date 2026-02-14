#!/bin/bash

app_env=${1:-development}

# Define build target - Capture OS Pro
APP_DIR="capture-os"

# Development environment commands
dev_commands() {
    echo "Running Capture OS Pro (development)..."
    cd "$APP_DIR" && NODE_ENV=development node server.js
}

# Production environment commands
prod_commands() {
    echo "Running Capture OS Pro (production)..."
    cd "$APP_DIR" && NODE_ENV=production node server.js
}

# Check environment variables to determine the running environment
if [ "$app_env" = "production" ] || [ "$app_env" = "prod" ] ; then
    echo "Production environment detected"
    prod_commands
else
    echo "Development environment detected"
    dev_commands
fi
