# Overview

Milk Market is a permissionless marketplace built on the Nostr protocol for Bitcoin-enabled commerce, specifically focused on raw milk and related products. The application implements multiple Nostr Implementation Possibilities (NIPs) to create a decentralized, censorship-resistant marketplace where users can buy and sell products using Bitcoin payments through Lightning Network, Cashu eCash tokens, and traditional fiat currencies.

The platform enables users to create product listings, manage orders, communicate through encrypted messaging, and handle payments across multiple currencies while maintaining privacy and self-sovereignty through Nostr's decentralized architecture.

# Recent Changes

## February 2026

- **Landing Page Optimization (YC Best Practices)**: Completely redesigned the landing page following YC startup landing page principles for improved conversion:

  - Single primary CTA in hero section ("Find Local Dairy Near You")
  - Outcome-first headline ("Farm-Fresh Raw Milk Direct to Your Door")
  - Shortened subheadline from 39 words to 15 words, removed jargon
  - Added social proof bar with trust metrics (50+ Local Farms, 200+ Products, 0% Fees)
  - Removed distracting floating animations throughout the page
  - Added Problem/Transformation comparison section
  - Simplified "How It Works" to 3-step process
  - Added FAQ accordion section with 5 common objections
  - Consolidated page from 10+ sections to focused 8-section layout
  - Updated "Why Choose Us" with specific numbers (0%, 100%, 24/7)

- **Herdshare Agreement Column in Orders Dashboard**: Added a new column to display herdshare agreement status for orders. Buyers see a "Sign Herdshare" button to sign unsigned agreements, while both buyers and sellers can view signed agreements via a "View Herdshare" button. The signing flow uses the PDFAnnotator component and encrypts the signed document before sending it back to the seller.

- **Stripe Connect Integration for Sellers**: Implemented full Stripe Connect Express flow so all sellers (not just the platform account) can accept credit card payments through their own connected Stripe accounts:

  - Added `stripe_connect_accounts` database table with helper functions (`getStripeConnectAccount`, `upsertStripeConnectAccount`)
  - Built 4 Stripe Connect API routes: `create-account`, `create-account-link`, `account-status`, `seller-status`
  - Created reusable `StripeConnectModal` and `StripeConnectBanner` components for prompting sellers
  - Added onboarding step 5 (`/onboarding/stripe-connect`) after shop profile setup with skip option
  - Integrated Stripe Connect prompts into Orders, My Listings, User Profile, and Shop Profile pages
  - Post-listing pop-up checks seller's Stripe status and prompts setup if needed
  - Updated payment flow: `isStripeMerchant` now dynamically checks seller's connected account via API
  - `create-invoice.ts` uses `stripeAccount` parameter for connected accounts; `check-payment.ts` supports `connectedAccountId`
  - Platform account (NEXT_PUBLIC_MILK_MARKET_PK) uses default Stripe credentials; other sellers use their connected accounts

- **Database Initialization Fix**: Fixed pre-existing bug where `is_read` and `order_id` index creation on `message_events` table failed when the table already existed without those columns, preventing all table initialization including migrations

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
- **Stripe Connect**: Express accounts for sellers to accept credit card payments, with platform-level connected account management via `stripe_connect_accounts` table
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

## Recent Changes

### Bulk/Bundle Pricing Feature (February 12, 2026)

- Added bulk pricing data model: `bulkPrices` (Map<number, number>), `selectedBulkOption`, and `bulkPrice` fields to ProductData type
- Created `BulkSelector` component (`components/utility-components/bulk-selector.tsx`) for buyer-side bundle selection dropdown
- Updated product parser (`utils/parsers/product-parser-functions.ts`) to parse "bulk" tags from Nostr events into bulkPrices Map
- Added seller UI in product form (`components/product-form.tsx`) with toggle switch and dynamic tier management (add/remove unit-price pairs)
- Product form writes bulk pricing as ["bulk", "units", "price"] Nostr event tags
- Integrated BulkSelector into checkout card (`components/utility-components/checkout-card.tsx`) with price calculation and display
- Updated cart page (`pages/cart/index.tsx`) to handle bulk selection, display bundle info, and use bulk prices in calculations
- Added bulk pricing to all order messages in both ProductInvoiceCard and CartInvoiceCard via "bulk" tag in constructGiftWrappedEvent
- Added `selectedBulkOption` to all message options (order-payment, order-receipt, order-info) in both invoice cards
- Added bulk option display in productDetails strings and order summary UI throughout both invoice cards
- Priority system: bulk pricing overrides single-unit price when selected (bulk > volume > base price)

### Size and Volume Options for Orders (February 2, 2026)

- Added "size" and "volume" tags to Nostr order messages via constructGiftWrappedEvent function
- Updated sendPaymentAndContactMessageWithKeys in CartInvoiceCard to pass product.selectedSize and product.selectedVolume in messageOptions for payment, receipt, and order-info messages
- Updated sendPaymentAndContactMessage in ProductInvoiceCard to pass selectedSize and selectedVolume at top level of messageOptions for all order message types
- Added "Order Specs" column to orders dashboard combining size and volume into formatted display
- Display format: "Size: S, Volume: 1 gal" when both present, individual values when only one, "N/A" when neither
- Updated OrderData interface to include selectedSize and selectedVolume fields
- Size and volume values are extracted from message tags and consolidated across related order messages

### Pickup Location Selection and Address Tag for Orders (January 24, 2026)

- Added pickup location dropdown in ProductInvoiceCard for contact orders when product has pickup shipping options (Pickup, Free/Pickup, Added Cost/Pickup) and pickupLocations array defined
- Added pickup location selection to CartInvoiceCard for multi-product cart orders, with product title displayed next to each dropdown for clarity
- Payment buttons disabled until pickup location is selected when required
- Added "pickup" tag to Nostr order messages via constructGiftWrappedEvent function
- Updated sendPaymentAndContactMessage in both ProductInvoiceCard and CartInvoiceCard to include pickup parameter
- Pickup tags are applied per-product, only to order messages corresponding to that specific product (not all products in cart)
- Added "Pickup Location" column to orders dashboard with proper tag parsing and display
- Pickup location state resets when form type changes to prevent stale selections
- Fixed "address" tag to be properly included in all order message types (payment, receipt, and info) when shipping information is provided
- Both ProductInvoiceCard and CartInvoiceCard now construct address tag early and pass it to all relevant message calls
- CartInvoiceCard handles both form field naming conventions (shippingName/shippingAddress and Name/Address)

### Order Status Persistence (January 23, 2026)

- Added `order_status` and `order_id` columns to `message_events` table for efficient order status tracking
- Created API endpoints for updating and retrieving order statuses (`/api/db/update-order-status`, `/api/db/get-order-statuses`)
- Orders dashboard now loads cached statuses from database first, then updates from parsed messages
- Status priority system prevents status downgrades (canceled > completed > shipped > confirmed > pending)
- Status persisted to database only when parsed status has higher priority than cached

### Unread/Read Indicator System (January 23, 2026)

- Added `is_read` column to `message_events` table for tracking read status
- Navbar displays styled unread count badge (purple in light mode, yellow in dark mode)
- New order indicators in orders dashboard with colored borders during current session
- Messages automatically marked as read when orders page opens
- Database migration handles existing deployments

### Deployment Configuration (October 4, 2025)

- Added health check endpoint at `/api/health` for Cloud Run deployment monitoring
- Configured production server to bind to `0.0.0.0` and respect PORT environment variable
- Removed `babel.config.json` to use Next.js 14's default SWC compiler for better performance
- Enhanced error handling in `_app.tsx` initialization with individual try-catch blocks for each data fetch operation
- Updated development workflow to run on port 5000
- Configured autoscale deployment with proper build and run commands
