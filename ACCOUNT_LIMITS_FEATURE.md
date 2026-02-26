# Account Limits During Creation and Update Feature

## Overview
This feature allows setting and updating account limits at the time of account creation or update, eliminating the need for separate API calls to the `/Accounts/:sid/Limits` endpoint.

## Changes Made

### Modified Files
- `lib/routes/api/accounts.js` - Added support for `limits` array during account creation and updates
  - Imported `AccountLimits` model
  - Added `validateLimits()` function to validate limit structure
  - Modified `POST /Accounts` route to create limit records automatically
  - Modified `PUT /Accounts/:sid` route to update/create limit records automatically
  - Updated `validateUpdate()` to validate limits in PUT requests
  - Backup created: `accounts.js.bak`

- `lib/swagger/swagger.yaml` - Updated API documentation
  - Added `limits` array property to POST /Accounts request schema
  - Added `limits` array property to PUT /Accounts/{AccountSid} request schema
  - Updated `Limits` schema to include all properties and correct enum values
  - Added new `AccountLimit` schema for request bodies
  - Backup created: `swagger.yaml.bak`

## Usage

### API Endpoints
- `POST /Accounts` - Create account with optional limits
- `PUT /Accounts/:sid` - Update account and/or limits

### Request Body
```json
{
  "name": "My Account",
  "service_provider_sid": "SP123",
  "limits": [
    {
      "category": "voice_call_session",
      "quantity": 100
    },
    {
      "category": "device",
      "quantity": 50
    },
    {
      "category": "api_rate",
      "quantity": 1000
    }
  ]
}
```

### Valid Limit Categories
- `api_rate`
- `voice_call_session`
- `device`
- `voice_call_minutes`
- `voice_call_session_license`
- `voice_call_minutes_license`

### Response
```json
{
  "sid": "account-uuid"
}
```

## Validation
- `limits` must be an array (if provided)
- Each limit must have a valid `category` from the allowed list
- Each limit must have a non-negative `quantity` (number)
- If validation fails, appropriate error message is returned

## Backward Compatibility
- The `limits` field is **optional**
- Existing API calls without `limits` continue to work as before
- Limits can still be added/modified via `POST /Accounts/:sid/Limits` endpoint

## Examples

### Create Account with Limits
```bash
curl -X POST http://api.jambonz.org/v1/Accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Customer A",
    "service_provider_sid": "SP123",
    "limits": [
      {"category": "voice_call_session", "quantity": 100},
      {"category": "device", "quantity": 25}
    ]
  }'
```

### Create Account without Limits (Legacy - Still Supported)
```bash
curl -X POST http://api.jambonz.org/v1/Accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Customer B",
    "service_provider_sid": "SP123"
  }'
```

### Update Account and Set/Update Limits
```bash
curl -X PUT http://api.jambonz.org/v1/Accounts/account-uuid \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Updated Name",
    "limits": [
      {"category": "voice_call_session", "quantity": 200},
      {"category": "api_rate", "quantity": 2000}
    ]
  }'
```

### Update Only Limits (Without Changing Account Details)
```bash
curl -X PUT http://api.jambonz.org/v1/Accounts/account-uuid \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "limits": [
      {"category": "voice_call_session", "quantity": 150}
    ]
  }'
```

## Error Handling
Invalid limit category:
```json
{
  "status": 400,
  "message": "invalid limit category: 'invalid_cat'. Must be one of: api_rate, voice_call_session, device, voice_call_minutes, voice_call_session_license, voice_call_minutes_license"
}
```

Invalid limit quantity:
```json
{
  "status": 400,
  "message": "invalid limit quantity for category 'device': must be a non-negative number"
}
```

## Testing Recommendations

### POST /Accounts (Create) Tests
1. Test account creation with valid limits
2. Test account creation without limits (backward compatibility)
3. Test with invalid limit categories
4. Test with invalid limit quantities (negative numbers, non-numbers)
5. Test with empty limits array
6. Verify limits are correctly stored in `account_limits` table
7. Test retrieval via `GET /Accounts/:sid/Limits` after creation

### PUT /Accounts/:sid (Update) Tests
1. Test updating account with new limits (should create them)
2. Test updating existing limits (should update quantities)
3. Test updating account details without touching limits
4. Test updating only limits without changing account details
5. Test updating some limits while leaving others untouched
6. Test with invalid limit categories during update
7. Test with invalid limit quantities during update
8. Verify limits are correctly updated in `account_limits` table
9. Verify retrieval via `GET /Accounts/:sid/Limits` shows updated values

## Implementation Details

### POST /Accounts (Create)
- Limits are created **after** the account is successfully created
- If account creation fails, no limits are created (atomic operation per the existing pattern)
- Limits are logged during creation for debugging purposes
- The feature follows the existing pattern used for webhooks (`registration_hook`, `queue_event_hook`)

### PUT /Accounts/:sid (Update)
- Limits are updated/created **after** the account is successfully updated
- For each limit in the request:
  - If a limit with that category already exists, it is **updated** with the new quantity
  - If a limit with that category does not exist, it is **created**
- Limits not mentioned in the request are **not deleted** (only updates/creates specified limits)
- To delete a limit, use `DELETE /Accounts/:sid/Limits?category=<category>`
- Limits are logged during update for debugging purposes

