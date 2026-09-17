# Backend

The backend is implemented using NestJS.

## Architecture

- Backend applications use NestJS.
- Reusable backend functionality belongs in Nx libraries.
- Applications contain composition and application-specific configuration.
- Domain functionality must live in a dedicated library.
- Persistence is implemented using TypeORM.
- HTTP APIs are defined using OpenAPI.

## Libraries

NestJS libraries must be created using the Nx Nest generator.

Applications must consume libraries through their public package name.

Never import internal source files from another Nx project.

Example:

```typescript
import { CoursesModule } from '@sco/courses';
```

## OpenAPI

Every backend domain exposed through HTTP must have an OpenAPI definition.

The OpenAPI document belongs to the library that owns the domain.

The OpenAPI contract is the source of truth for generated API abstractions and models.

Database
The database is relational.

Database designs must respect relational normalization principles.

Persistence is implemented using TypeORM.

