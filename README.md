# MapleStory Worlds Backend

A high-performance, secure backend service designed for MapleStory Worlds game servers. This backend handles real-time game entity management, data persistence, and streaming operations with built-in cryptographic security and multi-layered caching.

## Architecture Overview

The backend follows a modular, layered architecture designed for scalability and performance:

### Core Components

- **Server Layer** (`server.js`): Express.js REST API with security middleware
- **Command Processor** (`util/CommandProcessor.js`): Central command orchestration and encryption/decryption
- **Entity Management**:
  - `PersistentEntityManager.js`: Handles persistent entities (Account, Guild, Alliance, Party, PlayerCharacter)
  - `EphemeralEntityManager.js`: Manages temporary entities (OnlineMapData)
- **Data Layer**:
  - `HybridCacheManager.js`: Multi-tier caching (Redis + in-memory)
  - `StreamManager.js`: Real-time message streaming via Redis Streams
- **Database**: CockroachDB with Prisma ORM

### Security Features

- **Cryptographic Authentication**: Uses TweetNaCl for Box encryption/decryption
- **Sequence Number Validation**: Prevents replay attacks
- **Request Validation**: Multi-layer payload verification

### Entity Management

**Persistent Entities**: Stored in CockroachDB with Redis caching
- Account, Guild, Alliance, Party, PlayerCharacter

**Ephemeral Entities**: Stored only in Redis with TTL
- OnlineMapData (temporary game state)

### Batch Processing

All operations support efficient batching:
- Batch entity loading/saving
- Batch stream operations
- Parallel processing with result ordering preservation

## API Endpoints

- `GET /health` - Health check with service status
- `POST /process` - Main batch command processing endpoint

## Environment Variables

Create a `.env` file with the following required variables:

### Database Configuration
```env
DATABASE_URL=postgresql://user:password@host:port/database
```

### Redis Configuration (3 separate Redis instances)
```env
# Cache Redis - For general caching with volatile-ttl policy
CACHE_REDIS_URL=redis://user:password@host:port/0

# Ephemeral Redis - For temporary entities with noeviction policy
EPHEMERAL_REDIS_URL=redis://user:password@host:port/1

# Stream Redis - For message streaming with allkeys-lru policy
STREAM_REDIS_URL=redis://user:password@host:port/2
```

### Cryptographic Keys
```env
# Base64 encoded public key for request authentication
SENDER_PUBLIC_KEY=base64-encoded-public-key

# Base64 encoded private key for decryption
RECIPIENT_PRIVATE_KEY=base64-encoded-private-key
```

### Server Configuration
```env
# Port for the Express server (optional, defaults to 3000)
PORT=3000

# Node environment (optional, defaults to 'development')
NODE_ENV=production
```

## Installation & Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Generate Prisma client**:
   ```bash
   npm run db:generate
   ```

3. **Push database schema**:
   ```bash
   npm run db:push
   ```

4. **Set up environment variables** (see above section)

5. **Start the server**:
   ```bash
   # Development
   npm run dev

   # Production
   npm start
   ```

## Development

### Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm test` - Run Jest tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Generate test coverage report
- `npm run db:generate` - Generate Prisma client
- `npm run db:push` - Push schema changes to database
- `npm run db:migrate` - Run database migrations

### Testing

The project includes comprehensive test coverage for all major components:
- Unit tests for all managers and processors
- Integration tests for the command processing pipeline
- Health check and error handling tests

Run tests with:
```bash
npm test
```

## Deployment

This project is configured for deployment on Railway with:
- Automatic health checks via `/health` endpoint
- Nixpacks builder configuration
- Restart policy for failure handling

## Performance Features

- **Multi-tier Caching**: In-memory + Redis with intelligent cache invalidation
- **Batch Processing**: All operations optimized for batch execution
- **Connection Pooling**: Efficient database and Redis connection management
- **Parallel Processing**: Concurrent handling of different operation types
- **Streaming**: Real-time data streaming for live game updates

## Security Considerations

- All requests must be cryptographically signed and encrypted
- Sequence number validation prevents replay attacks
- Environment variables must be properly secured in production
- Redis instances are segmented by use case with appropriate memory policies