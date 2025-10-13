// Global test setup
global.console = {
  ...console,
  // Mock console methods to avoid noise in tests unless explicitly testing them
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock environment variables for tests
process.env.SENDER_PUBLIC_KEY = 'dGVzdFB1YmxpY0tleQ=='; // base64 encoded test key
process.env.RECIPIENT_PRIVATE_KEY = 'dGVzdFByaXZhdGVLZXk='; // base64 encoded test key
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.EPHEMERAL_REDIS_URL = 'redis://localhost:6379/0';
process.env.STREAM_REDIS_URL = 'redis://localhost:6379/1';
process.env.CACHE_REDIS_URL = 'redis://localhost:6379/2';
process.env.RATE_LIMIT_WINDOW_MS = '60000'; // 1 minute
process.env.RATE_LIMIT_MAX_REQUESTS = '200';
process.env.CACHE_TTL_SECONDS = '60'; // 1 minute
process.env.CACHE_MAX_SIZE = '5000';
process.env.NODE_ENV = 'test';

// Mock performance.now for consistent timing tests
global.performance = {
  now: jest.fn(() => 1000)
};

// Clear all mocks after each test
afterEach(() => {
  jest.clearAllMocks();
});
