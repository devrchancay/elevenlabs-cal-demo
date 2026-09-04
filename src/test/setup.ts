/**
 * Minimal environment for the test suite. No test touches the network or the
 * real Cal.com API.
 */
process.env.NODE_ENV = 'test';
process.env.CAL_API_KEY = 'cal_test_key';
process.env.CAL_EVENT_TYPE_ID = '123456';
process.env.BUSINESS_TIMEZONE = 'America/Guayaquil';
process.env.TOOLS_SHARED_SECRET = 'secreto-de-pruebas-1234567890';
process.env.ELEVENLABS_WEBHOOK_SECRET = 'wsec_test_secret';
process.env.LOG_LEVEL = 'silent';
