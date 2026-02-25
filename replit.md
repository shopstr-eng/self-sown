# Overview

Milk Market is a permissionless marketplace built on the Nostr protocol for Bitcoin-enabled commerce, specializing in raw milk and related products. It leverages various Nostr Implementation Possibilities (NIPs) to offer a decentralized, censorship-resistant platform. Users can buy and sell products using Bitcoin via Lightning Network, Cashu eCash tokens, and traditional fiat currencies. The platform supports product listings, order management, encrypted communication, and multi-currency payments, emphasizing user privacy and self-sovereignty within Nostr's architecture. Recent enhancements include a dedicated order summary page, an email notification system with guest checkout, a redesigned landing page for improved conversion, and integration with Stripe Connect for sellers to accept credit card payments.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

- **Framework**: Next.js 14 with TypeScript and React 18.
- **Styling**: Tailwind CSS with NextUI for consistent design.
- **State Management**: React Context API for global state.
- **Client Storage**: Dexie (IndexedDB wrapper) for offline caching.
- **PWA Support**: Next-PWA for progressive web app capabilities.

## Backend Architecture

- **API Routes**: Next.js API routes for server-side logic.
- **Database**: PostgreSQL for relational data storage.
- **File Handling**: Formidable for file uploads.
- **Middleware**: Custom Next.js middleware for routing.

## Authentication & Signing

- **Multiple Signer Support**: NIP-07, NIP-46, and direct nsec key input.
- **Key Management**: NIP-49 encrypted private key storage.
- **Migration System**: Automatic migration to NIP-49 standard.

## Nostr Protocol Implementation

- **Core NIPs**: Implements 15+ NIPs for profiles (NIP-01, NIP-05), marketplace (NIP-99), private messaging (NIP-17), media (Blossom), reviews (NIP-85), and social graph (NIP-02, NIP-51).
- **Relay Management**: Multi-relay support with configurable lists (NIP-65).
- **Event Caching**: Local caching of Nostr events.

## Payment Systems

- **Lightning Network**: Direct invoice generation and payment verification.
- **Cashu eCash**: Integration with Cashu mints.
- **Stripe Connect**: Express accounts for sellers to accept credit card payments.
- **Fiat Support**: Traditional payment processing.
- **Multi-Currency**: Support for dynamic currency conversion.

## Data Management

- **Event Parsing**: Custom parsers for various data types.
- **Caching Strategy**: Hybrid local IndexedDB and real-time Nostr events.
- **File Storage**: Blossom server integration for decentralized media.
- **Encryption**: NIP-44 for private messages and documents.

## Trust & Web of Trust

- **Social Graph**: Follow-based trust system.
- **Review System**: User reviews with weighted scoring.
- **WoT Filtering**: Filtering based on follow relationships.

## Key Features

- **Order Summary Page**: Dedicated page post-purchase, displaying product details, cost, payment, and shipping.
- **Email Notifications & Guest Checkout**: Transactional emails via SendGrid for order confirmations, seller alerts, and shipping updates; allows purchases without sign-in using an email.
- **Landing Page Optimization**: Redesigned following YC best practices for improved conversion with a clear CTA, outcome-first headline, social proof, and simplified sections.
- **Herdshare Agreement Management**: Column in orders dashboard for signing and viewing herdshare agreements using PDFAnnotator.
- **Stripe Connect Integration**: Full Stripe Connect Express flow for sellers to accept credit card payments via their own connected accounts.
- **Bulk/Bundle Pricing**: Allows sellers to define tiered pricing based on quantity, displayed and calculated in the checkout flow.
- **Size and Volume Options**: Integration of product size and volume selections into order messages and dashboard displays.
- **Pickup Location Selection**: Option for buyers to select pickup locations for orders with pickup shipping methods.
- **Order Status Persistence**: Database persistence of order statuses with a priority system to prevent downgrades, ensuring consistent tracking.
- **Unread/Read Indicator System**: Tracks read status of messages and orders, with visual indicators and automatic marking as read.
- **Image Compression**: Automatic compression of large images before Blossom uploads, converting to WebP and scaling resolution if necessary.
- **Cart Multi-Payment Support**: When all cart products are from the same merchant, Stripe (credit card) and fiat payment options (cash, payment apps) are available alongside Bitcoin options. Multi-merchant carts remain Bitcoin-only with an informational note.

# External Dependencies

## Nostr Infrastructure

- **Nostr Relays**: For event publishing and subscription.
- **Blossom Servers**: For decentralized media storage.
- **NIP-05 Verification**: For DNS-based identity verification.

## Payment Services

- **Lightning Network**: For invoice generation and verification.
- **Cashu Mints**: For eCash token services.
- **Getalby Lightning Tools**: For Lightning address and payment utilities.
- **Stripe**: For credit card payment processing via Stripe Connect.
- **SendGrid**: For transactional email services.

## Third-Party Libraries

- **Cryptography**: `crypto-js`, `nostr-tools`, `@cashu/cashu-ts`.
- **UI Components**: `@nextui-org/react`, `@heroicons/react`, `framer-motion`.
- **File Processing**: `pdf-lib`, `qrcode`.
