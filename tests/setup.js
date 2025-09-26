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

// Mock performance.now for consistent timing tests
global.performance = {
  now: jest.fn(() => 1000)
};

// Clear all mocks after each test
afterEach(() => {
  jest.clearAllMocks();
});
