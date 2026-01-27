const LISTING_ID = '637d17a91ea4b0002f3801a3';

// In-memory cache (for warm instances)
let cachedToken = null;
let tokenExpiry = 0;

// Availability cache - reduce API calls
let cachedAvailability = null;
let availabilityCacheTime = 0;
const AVAILABILITY_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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
      const waitTime = Math.pow(2, retryCount) * 1000;
      await delay(waitTime);
      return getAccessToken(retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token failed: ${response.status} - ${text}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error(`No token in response: ${JSON.stringify(data)}`);
    }

    // Cache token in memory
    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in * 1000);

    // Cache token in Redis (expires in 23 hours)
    await setInRedis('guesty_token', { token: cachedToken, expiry: tokenExpiry }, 82800);

    return cachedToken;
  } catch (error) {
    // Fallback to any cached token
    if (cachedToken && now < tokenExpiry + 3600000) {
      return cachedToken;
    }
    if (stored && stored.token) {
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
    const now = Date.now();

    // Return cached availability if still fresh
    if (cachedAvailability && now < availabilityCacheTime + AVAILABILITY_CACHE_DURATION) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cachedAvailability)
      };
    }

    // Check env vars
    if (!process.env.GUESTY_CLIENT_ID || !process.env.GUESTY_CLIENT_SECRET) {
      throw new Error('Missing GUESTY_CLIENT_ID or GUESTY_CLIENT_SECRET environment variables');
    }

    const token = await getAccessToken();

    // Get calendar for next 12 months
    const today = new Date();
    const endDate = new Date(today);
    endDate.setMonth(endDate.getMonth() + 12);

    const startStr = today.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const response = await fetch(
      `https://booking.guesty.com/api/listings/${LISTING_ID}/calendar?from=${startStr}&to=${endStr}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Handle rate limiting
    if (response.status === 429) {
      // Return cached data if available
      if (cachedAvailability) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cachedAvailability)
        };
      }
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Service busy, please try again' })
      };
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Calendar failed: ${response.status} - ${text}`);
    }

    const calendar = await response.json();

    // Log rate limit info for monitoring
    const rateLimitInfo = {
      remainingSecond: response.headers.get('X-RateLimit-Remaining-Second'),
      remainingMinute: response.headers.get('X-RateLimit-Remaining-Minute'),
      remainingHour: response.headers.get('X-RateLimit-Remaining-Hour')
    };
    console.log('Guesty Rate Limits (availability):', rateLimitInfo);

    // Cache the availability data
    cachedAvailability = { ...calendar, _rateLimits: rateLimitInfo };
    availabilityCacheTime = now;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...calendar, _rateLimits: rateLimitInfo })
    };
  } catch (error) {
    // Return cached data on error if available
    if (cachedAvailability) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cachedAvailability)
      };
    }
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};
