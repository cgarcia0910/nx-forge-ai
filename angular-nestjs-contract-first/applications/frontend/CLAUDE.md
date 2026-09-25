# Frontend

The frontend is implemented using Angular.

## Architecture

- Frontend applications use Angular with standalone components.
- Reusable frontend functionality belongs in Nx libraries under `libs/frontend/*`.
- Applications contain composition and application-specific configuration.
- Domain functionality must live in a dedicated library.
- HTTP calls to the backend should use OpenAPI-generated client code and types to preserve contract-first guarantees.

## Libraries

Angular libraries must be created using the Nx Angular generator.

Applications must consume libraries through their public package name.

Never import internal source files from another Nx project.

Example:

```typescript
import { HeaderComponent } from '@org/shared-ui';
```

## OpenAPI

Every backend API consumed by the frontend should have an OpenAPI-generated client library and type definitions.

The generated client and models are the source of truth for backend integration.
