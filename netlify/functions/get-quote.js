const LISTING_ID = '637d17a91ea4b0002f3801a3';

async function getAccessToken() {
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
  const data = await response.json();
  return data.access_token;
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
        checkIn: checkIn,
        checkOut: checkOut,
        guestsCount: parseInt(guests) || 2
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Quote request failed: ${response.status}`);
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
