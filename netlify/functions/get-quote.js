const LISTING_ID = '637d17a91ea4b0002f3801a3';

// Token cache - persists across warm function invocations
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  // Return cached token if still valid (with 1 hour buffer)
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 3600000) {
    return cachedToken;
  }

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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token failed: ${response.status} - ${text}`);
  }

  const data = await response.json();

  // Cache token (expires_in is usually 86400 seconds = 24 hours)
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in * 1000);

  return cachedToken;
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

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Quote request failed: ${response.status} - ${errorText}`);
    }

    const quote = await response.json();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quote)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
