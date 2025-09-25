# Overview

Milk Market is a permissionless marketplace built on the Nostr protocol for Bitcoin-enabled commerce, specifically focused on raw milk and related products. The application implements multiple Nostr Implementation Possibilities (NIPs) to create a decentralized, censorship-resistant marketplace where users can buy and sell products using Bitcoin payments through Lightning Network, Cashu eCash tokens, and traditional fiat currencies.

The platform enables users to create product listings, manage orders, communicate through encrypted messaging, and handle payments across multiple currencies while maintaining privacy and self-sovereignty through Nostr's decentralized architecture.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

- **Framework**: Next.js 14 with TypeScript and React 18
- **Styling**: Tailwind CSS with NextUI component library for consistent UI design
- **State Management**: React Context API for global state (profiles, products, chats, reviews, follows, relays)
- **Client Storage**: Dexie (IndexedDB wrapper) for offline-first data caching and persistence
- **PWA Support**: Next-PWA for progressive web app capabilities with service worker implementation

## Backend Architecture

- **API Routes**: Next.js API routes for server-side functionality
- **Database**: PostgreSQL with pg driver for relational data storage
- **File Handling**: Formidable for file uploads and processing
- **Middleware**: Custom Next.js middleware for routing (npub/naddr redirects)

## Authentication & Signing

- **Multiple Signer Support**:
  - NIP-07 (browser extension wallets)
  - NIP-46 (remote signing/bunker)
  - Direct nsec key input
- **Key Management**: NIP-49 encrypted private key storage with passphrase protection
- **Migration System**: Automatic migration from legacy encryption to NIP-49 standard

## Nostr Protocol Implementation

- **Core NIPs**: Implements 15+ Nostr Implementation Possibilities including:
  - Profile management (NIP-01, NIP-05)
  - Marketplace listings (NIP-99)
  - Private messaging (NIP-17, gift-wrapped DMs)
  - Media attachments (Blossom protocol)
  - Reviews and ratings (NIP-85)
  - Follow lists and social graph (NIP-02, NIP-51)
- **Relay Management**: Multi-relay support with configurable relay lists (NIP-65)
- **Event Caching**: Local caching of Nostr events for improved performance

## Payment Systems

- **Lightning Network**: Direct Lightning invoice generation and payment verification
- **Cashu eCash**: Integration with Cashu mints for privacy-preserving Bitcoin payments
- **Fiat Support**: Traditional payment processing for fiat currency transactions
- **Multi-Currency**: Support for multiple currencies with dynamic conversion

## Data Management

- **Event Parsing**: Custom parsers for product data, profiles, reviews, and messages
- **Caching Strategy**: Hybrid approach using local IndexedDB and real-time Nostr events
- **File Storage**: Blossom server integration for decentralized media storage
- **Encryption**: NIP-44 encryption for private messages and sensitive documents

## Trust & Web of Trust

- **Social Graph**: Follow-based trust system with configurable trust levels
- **Review System**: User reviews and ratings with weighted scoring algorithms
- **WoT Filtering**: Web of Trust filtering based on follow relationships

# External Dependencies

## Nostr Infrastructure

- **Nostr Relays**: Multiple relay connections for event publishing and subscription
- **Blossom Servers**: Decentralized media storage servers for images and files
- **NIP-05 Verification**: DNS-based identity verification system

## Payment Services

- **Lightning Network**: Lightning invoice generation and payment verification
- **Cashu Mints**: eCash token minting and redemption services
- **Getalby Lightning Tools**: Lightning address and payment utilities

## Third-Party Libraries

- **Cryptography**:
  - `crypto-js` for encryption utilities
  - `nostr-tools` for Nostr protocol implementation
  - `@cashu/cashu-ts` for Cashu eCash functionality
- **UI Components**:
  - `@nextui-org/react` for component library
  - `@heroicons/react` for iconography
  - `framer-motion` for animations
- **File Processing**:
  - `pdf-lib` for PDF document manipulation
  - `qrcode` for QR code generation
  - Custom file encryption for sensitive documents

## Development Tools

- **Testing**: Jest with React Testing Library for component testing
- **Linting**: ESLint with TypeScript and Next.js configurations
- **Code Quality**: Prettier for code formatting, TypeScript for type safety
- **Security**: Semgrep for security scanning and vulnerability detection
