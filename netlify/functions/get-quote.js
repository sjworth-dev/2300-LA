const LISTING_ID = '637d17a91ea4b0002f3801a3';

// Token cache - persists across warm function invocations
let cachedToken = null;
let tokenExpiry = 0;

// Simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getAccessToken(retryCount = 0) {
  // Return cached token if still valid (with 5 min buffer)
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 300000) {
    return cachedToken;
  }

  try {
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
      const waitTime = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
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

    return cachedToken;
  } catch (error) {
    // If we have a cached token that's not too old, use it as fallback
    if (cachedToken && now < tokenExpiry + 3600000) {
      return cachedToken;
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
