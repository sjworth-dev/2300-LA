const { getStore } = require('@netlify/blobs');

const LISTING_ID = '637d17a91ea4b0002f3801a3';
const TOKEN_KEY = 'guesty_oauth_token';

// In-memory cache (for warm instances)
let cachedToken = null;
let tokenExpiry = 0;

// Simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Get token from Netlify Blobs
async function getStoredToken() {
  try {
    const store = getStore('guesty-auth');
    const data = await store.get(TOKEN_KEY, { type: 'json' });
    if (data && data.token && data.expiry > Date.now()) {
      return data;
    }
  } catch (error) {
    console.log('Could not read from blob store:', error.message);
  }
  return null;
}

// Save token to Netlify Blobs
async function storeToken(token, expiry) {
  try {
    const store = getStore('guesty-auth');
    await store.setJSON(TOKEN_KEY, { token, expiry });
    console.log('Token stored in blob store, expires:', new Date(expiry).toISOString());
  } catch (error) {
    console.log('Could not write to blob store:', error.message);
  }
}

async function getAccessToken(retryCount = 0) {
  const now = Date.now();

  // Check in-memory cache first (fastest)
  if (cachedToken && now < tokenExpiry - 300000) {
    return cachedToken;
  }

  // Check blob storage (survives cold starts)
  const stored = await getStoredToken();
  if (stored && now < stored.expiry - 300000) {
    // Update in-memory cache
    cachedToken = stored.token;
    tokenExpiry = stored.expiry;
    console.log('Using token from blob store');
    return cachedToken;
  }

  // Need to fetch a new token
  try {
    console.log('Fetching new OAuth token from Guesty...');
    const response = await fetch('https://booking.guesty.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'booking_engine:api',
        client_id: process.env.GUESTY_CLIENT_ID,
        client_secret: process.env.GUESTY_CLIENT_SECRET
      })
    });

    // Handle rate limiting with retry
    if (response.status === 429 && retryCount < 3) {
      const retryAfter = response.headers.get('Retry-After') || Math.pow(2, retryCount + 1);
      const waitTime = parseInt(retryAfter) * 1000;
      console.log(`Rate limited, waiting ${waitTime}ms before retry ${retryCount + 1}`);
      await delay(waitTime);
      return getAccessToken(retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token failed: ${response.status} - ${text}`);
    }

    const data = await response.json();

    // Cache token (expires_in is usually 86400 seconds = 24 hours)
    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in * 1000);

    // Store in blob for persistence across cold starts
    await storeToken(cachedToken, tokenExpiry);

    return cachedToken;
  } catch (error) {
    // If we have any cached token that's not too old, use it as fallback
    if (cachedToken && now < tokenExpiry + 3600000) {
      console.log('Using fallback in-memory token');
      return cachedToken;
    }
    if (stored && now < stored.expiry + 3600000) {
      console.log('Using fallback blob token');
      return stored.token;
    }
    throw error;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }

  try {
    const { checkIn, checkOut, guests } = event.queryStringParameters || {};

    if (!checkIn || !checkOut) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'checkIn and checkOut dates required' })
      };
    }

    const token = await getAccessToken();

    // Create a reservation quote
    const response = await fetch('https://booking.guesty.com/api/reservations/quotes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        listingId: LISTING_ID,
        checkInDateLocalized: checkIn,
        checkOutDateLocalized: checkOut,
        guestsCount: parseInt(guests) || 2
      })
    });

    // Handle rate limiting on quote request
    if (response.status === 429) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: 'Service is busy. Please try again in a moment.',
          retryAfter: 5
        })
      };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Quote request failed: ${response.status} - ${errorText}`);
    }

    const quote = await response.json();

    // Log rate limit info for monitoring
    const rateLimitInfo = {
      remainingSecond: response.headers.get('X-RateLimit-Remaining-Second'),
      remainingMinute: response.headers.get('X-RateLimit-Remaining-Minute'),
      remainingHour: response.headers.get('X-RateLimit-Remaining-Hour')
    };
    console.log('Guesty Rate Limits (quote):', rateLimitInfo);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      },
      body: JSON.stringify({
        ...quote,
        _rateLimits: rateLimitInfo
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
