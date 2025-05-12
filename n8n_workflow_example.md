# Using the Web Crawler with n8n and Django

This document explains how to create an n8n workflow that uses the web crawler and sends the data to the Django backend.

## Overview

The workflow will:
1. Trigger based on some condition (e.g., schedule, webhook)
2. Get user information and benchmark ID
3. Make a request to the web crawler API
4. The web crawler will automatically save data to Django

## n8n Workflow Setup

### 1. Create a Trigger Node

Choose one of these options:
- **Schedule Trigger**: To run crawling at specific times
- **Webhook Trigger**: To run crawling when requested via an API call
- **Manual Trigger**: To run crawling manually

### 2. HTTP Request Node - Get User Information

Configure an HTTP Request node to get user information from Django:

```
Method: GET
URL: http://localhost:8000/api/user-info/
Authentication: Bearer Token
Headers: 
  Content-Type: application/json
```

This will return user information including the user ID.

### 3. HTTP Request Node - Get Benchmark

Configure an HTTP Request node to get the active benchmark:

```
Method: GET 
URL: http://localhost:8000/api/benchmarks/
Authentication: Bearer Token
Headers:
  Content-Type: application/json
```

Use an n8n Expression to get the first benchmark ID:
```
{{ $node["HTTP Request"].json.benchmarks[0].id }}
```

### 4. HTTP Request Node - Web Crawler

Configure an HTTP Request node to call the web crawler API:

```
Method: POST
URL: http://localhost:3005/api/screenshots
Headers:
  Content-Type: application/json
Body:
{
  "urls": ["https://example.com", "https://another-website.com"],
  "userId": "{{ $node["HTTP Request User"].json.id }}",
  "benchmarkId": "{{ $node["HTTP Request Benchmark"].json.benchmarks[0].id }}"
}
```

### 5. Set Success/Error Handling

Add nodes to handle success or error responses from the web crawler.

## Complete Workflow Example

Here's an example of the complete workflow in JSON format that you can import into n8n:

```json
{
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "hours",
              "minutesInterval": 6
            }
          ]
        }
      },
      "name": "Schedule Trigger",
      "type": "n8n-nodes-base.scheduleTrigger",
      "position": [
        250,
        300
      ]
    },
    {
      "parameters": {
        "url": "http://localhost:8000/api/get-user-info/",
        "authentication": "headerAuth",
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "Bearer YOUR_TOKEN_HERE"
            }
          ]
        }
      },
      "name": "Get User",
      "type": "n8n-nodes-base.httpRequest",
      "position": [
        450,
        300
      ]
    },
    {
      "parameters": {
        "url": "http://localhost:8000/api/benchmarks/",
        "authentication": "headerAuth",
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "Bearer YOUR_TOKEN_HERE"
            }
          ]
        }
      },
      "name": "Get Benchmark",
      "type": "n8n-nodes-base.httpRequest",
      "position": [
        650,
        300
      ]
    },
    {
      "parameters": {
        "url": "http://localhost:3005/api/screenshots",
        "method": "POST",
        "bodyParametersUi": {
          "parameter": [
            {
              "name": "urls",
              "value": "[\"https://example.com\", \"https://another-site.com\"]"
            },
            {
              "name": "userId",
              "value": "={{ $node[\"Get User\"].json.id }}"
            },
            {
              "name": "benchmarkId",
              "value": "={{ $node[\"Get Benchmark\"].json.benchmarks[0].id }}"
            }
          ]
        }
      },
      "name": "Call Web Crawler",
      "type": "n8n-nodes-base.httpRequest",
      "position": [
        850,
        300
      ]
    }
  ],
  "connections": {
    "Schedule Trigger": {
      "main": [
        [
          {
            "node": "Get User",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Get User": {
      "main": [
        [
          {
            "node": "Get Benchmark",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Get Benchmark": {
      "main": [
        [
          {
            "node": "Call Web Crawler",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}
```

## Testing the Integration

1. Make sure your Django backend is running on port 8000
2. Make sure your web crawler is running on port 3005
3. Create a test workflow in n8n and run it
4. Check the Django admin interface to see if the CompanyData and WebSearchData objects were created

## Troubleshooting

- If the web crawler isn't saving to Django, check the web crawler logs for errors
- Ensure the user ID and benchmark ID are being correctly passed
- Verify the Django API endpoints are accessible from the web crawler
- Check that all required fields are present in the request 