# Light Hair Video Reel

## Overview

Light Hair is a modern video reel showcase that displays a curated collection of cinematographic work through an immersive scrolling experience. The application presents video clips in a continuous vertical layout with sophisticated parallax effects, creating a seamless viewing experience optimized for both desktop and mobile devices.

The system dynamically loads video content from Vimeo using a JSON manifest, implements intelligent loading strategies, and provides smooth visual transitions. Each video clip can be configured with individual parallax speeds, vertical overlaps, and aspect ratios for precise creative control.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Pure JavaScript Implementation**: No frameworks or libraries except for Vimeo Player API
- **Responsive Design**: Mobile-first approach with device-specific optimizations using CSS media queries
- **CSS Grid/Flexbox**: Minimal layout system using native CSS capabilities
- **Progressive Enhancement**: Graceful degradation for older browsers with feature detection

### Content Management
- **JSON Manifest System**: Centralized configuration file (`manifest.json`) containing:
  - Video metadata (titles, Vimeo embed URLs)
  - Visual parameters (parallax speeds, overlap values, aspect ratios)
  - Global configuration (parallax gain, smoothing factors)
- **Dynamic DOM Generation**: Runtime construction of video elements based on manifest data
- **Cache Busting**: Timestamp-based cache invalidation for manifest updates

### Video Loading Strategy
- **Platform-Specific Loading**:
  - Desktop: Concurrent loading with intersection observer for performance
  - Mobile: Sequential loading without lazy attributes for reliability
- **Intelligent Mounting**: Device-aware iframe creation with proper Vimeo parameters
- **Quality Management**: Automatic quality capping on mobile devices (360p/540p preference)

### Visual Effects System
- **Element-Relative Parallax**: Each clip's motion calculated relative to viewport center rather than global scroll position
- **Configurable Transform Pipeline**:
  - Parallax effects applied to outer `.clip` containers
  - Overlap adjustments applied to inner `.frame` elements
  - Hardware acceleration with `translate3d` and `will-change` properties
- **Motion Preferences**: Respects user's `prefers-reduced-motion` setting

### Audio Integration
- **Click-to-Start Audio**: Invisible overlay captures first user interaction to enable audio playback
- **Web Audio API**: Background audio management with proper user consent handling
- **Accessibility**: Keyboard navigation support for audio unlock

### Mobile Optimization
- **Orchestrated Playback**: Smart play/pause management to prevent resource conflicts
- **Recovery Systems**:
  - BlackGuard: Detects and recovers videos that never start playing
  - Stall detection: Identifies and nudges frozen video players
- **iOS-Specific Handling**: Removes lazy loading attributes and implements stricter mounting sequences

### Performance Considerations
- **RequestAnimationFrame**: Smooth scroll-based animations using browser's render loop
- **Transform Caching**: Minimizes layout thrashing through transform-only animations
- **Memory Management**: Careful iframe lifecycle management to prevent memory leaks
- **Preconnection**: DNS prefetching and connection warming for Vimeo CDN

### Error Handling
- **Graceful Degradation**: Fallback behaviors when video loading fails
- **Retry Logic**: Automatic retry mechanisms for failed video loads
- **Kill Switches**: Runtime feature toggles for debugging and rollback capabilities

## External Dependencies

### Core Dependencies
- **Vimeo Player API**: Official Vimeo JavaScript SDK for video player control and event handling
- **Vimeo CDN**: Video hosting and delivery through Vimeo's content delivery network
  - `player.vimeo.com` - Player JavaScript API
  - `i.vimeocdn.com` - Video thumbnails and metadata
  - `f.vimeocdn.com` - Video file delivery

### Browser APIs
- **Intersection Observer API**: Viewport-based loading triggers and visibility detection
- **RequestAnimationFrame**: Smooth animation timing and render synchronization
- **Web Audio API**: Background audio playback control
- **URL API**: Robust URL parameter manipulation for Vimeo embed configuration
- **Media Query API**: Responsive design and user preference detection

### Network Optimization
- **DNS Prefetching**: Pre-resolution of Vimeo domain names
- **Preconnection**: Early connection establishment to Vimeo CDN endpoints
- **Cache Control**: Strategic caching policies for manifest and static assets

### Development Tools
- **Version Control Integration**: Git-based deployment workflow
- **Asset Versioning**: Query parameter-based cache busting for static resources
- **Performance Monitoring**: Built-in diagnostics and debugging utilities