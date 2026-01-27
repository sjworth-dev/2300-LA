// In-memory cache (for warm instances)
let cachedToken = null;
let tokenExpiry = 0;

// Simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Upstash Redis helpers
async function getFromRedis(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const response = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (error) {
    console.log('Redis get error:', error.message);
    return null;
  }
}

async function setInRedis(key, value, expirySeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  try {
    await fetch(`${url}/set/${key}/${encodeURIComponent(JSON.stringify(value))}/ex/${expirySeconds}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Token stored in Redis');
  } catch (error) {
    console.log('Redis set error:', error.message);
  }
}

async function getAccessToken(retryCount = 0) {
  const now = Date.now();

  // Check in-memory cache first
  if (cachedToken && now < tokenExpiry - 300000) {
    console.log('Using in-memory cached token');
    return cachedToken;
  }

  // Check Redis (survives cold starts)
  const stored = await getFromRedis('guesty_token');
  if (stored && stored.expiry && now < stored.expiry - 300000) {
    console.log('Using Redis cached token');
    cachedToken = stored.token;
    tokenExpiry = stored.expiry;
    return cachedToken;
  }

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

    // Cache token in memory
    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in * 1000);

    // Cache token in Redis (expires in 23 hours)
    await setInRedis('guesty_token', { token: cachedToken, expiry: tokenExpiry }, 82800);

    return cachedToken;
  } catch (error) {
    // Fallback to any cached token
    if (cachedToken && now < tokenExpiry + 3600000) {
      console.log('Using fallback in-memory token');
      return cachedToken;
    }
    if (stored && stored.token) {
      console.log('Using fallback Redis token');
      return stored.token;
    }
    throw error;
  }
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { quoteId, ratePlanId, ccToken, guest } = JSON.parse(event.body);

    // Validate required fields
    if (!quoteId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Quote ID is required' })
      };
    }

    if (!ccToken) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Payment token is required' })
      };
    }

    if (!guest || !guest.firstName || !guest.lastName || !guest.email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Guest information (firstName, lastName, email) is required' })
      };
    }

    const token = await getAccessToken();

    // Build the reservation request body
    const reservationBody = {
      ccToken: ccToken,
      guest: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        email: guest.email
      }
    };

    // Add optional phone if provided
    if (guest.phone) {
      reservationBody.guest.phone = guest.phone;
    }

    // Add ratePlanId if provided
    if (ratePlanId) {
      reservationBody.ratePlanId = ratePlanId;
    }

    console.log('Creating reservation for quote:', quoteId);
    console.log('Request body:', JSON.stringify(reservationBody, null, 2));

    // Create instant reservation using the quote
    const response = await fetch(
      `https://booking.guesty.com/api/reservations/quotes/${quoteId}/instant`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(reservationBody)
      }
    );

    // Log rate limit info
    const rateLimitInfo = {
      remainingSecond: response.headers.get('X-RateLimit-Remaining-Second'),
      remainingMinute: response.headers.get('X-RateLimit-Remaining-Minute'),
      remainingHour: response.headers.get('X-RateLimit-Remaining-Hour')
    };
    console.log('Guesty Rate Limits (reservation):', rateLimitInfo);

    // Handle rate limiting
    if (response.status === 429) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: 'Service is busy. Please try again in a moment.',
          retryAfter: 5
        })
      };
    }

    const responseText = await response.text();
    let reservation;

    try {
      reservation = JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse response:', responseText);
      throw new Error(`Invalid response from booking service`);
    }

    if (!response.ok) {
      console.error('Reservation failed:', response.status, responseText);

      // Extract error message from Guesty response
      const errorMessage = reservation.message || reservation.error || 'Failed to create reservation';

      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: errorMessage,
          details: reservation
        })
      };
    }

    console.log('Reservation created successfully:', reservation._id || reservation.confirmationCode);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        reservation: {
          _id: reservation._id,
          confirmationCode: reservation.confirmationCode,
          status: reservation.status,
          checkIn: reservation.checkIn || reservation.checkInDateLocalized,
          checkOut: reservation.checkOut || reservation.checkOutDateLocalized,
          guestName: `${guest.firstName} ${guest.lastName}`,
          guestEmail: guest.email
        },
        _rateLimits: rateLimitInfo
      })
    };

  } catch (error) {
    console.error('Create reservation error:', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: error.message || 'An unexpected error occurred'
      })
    };
  }
};
