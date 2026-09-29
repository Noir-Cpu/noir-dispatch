# ADR 0008: Expo (React Native) for the driver app

Status: accepted

**Context.** Drivers need location updates while the screen is off or the app is in the background. A web app cannot do that reliably.

**Decision.** Expo (React Native) with `expo-location` background tasks. One language (TypeScript) across API, web and mobile, sharing the Zod/TypeScript types. Flutter would mean Dart with no code reuse; Kotlin is Android-only and doubles the work.

**Consequences.** Background location on iOS and Android needs a development build (not Expo Go), permission strings, and store review justification. The driver app in this repo is a scaffold (see `apps/driver`); the same driver actions are also available in the simulator and through the HTTP API.
