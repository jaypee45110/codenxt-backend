# codeNXT Backend Architecture

## Core principle

codeNXT is one shared platform with multiple isolated verticals.

Shared infrastructure may be reused across verticals. Business logic must not be shared across verticals unless it has first been extracted into a neutral shared utility.

## Shared infrastructure

The following may be shared:

- Express server setup
- Redis client
- PostgreSQL access
- Upload/storage utilities
- Auth/admin utilities
- SMS and mail utilities
- Logging
- Generic validation helpers

## Vertical isolation

Each vertical must own its own:

- data model
- API contract
- Redis key prefix
- reward logic
- scan logic
- reporting logic
- validation/redemption logic
- domain language

No vertical may call another vertical's normalizers, assignment functions, Redis prefixes, or business rules.

## Current verticals

- codePerks
- codeDemo
- codePod
- codeClip
- codeTone
- codeStack
- codePage

Future verticals may include:

- codeFest
- codeExpo

## codeClip rule

codeClip must be isolated from codePod from the start.

codeClip must not use:

- codePod normalizers
- codePod assignment functions
- codePod Redis prefixes
- codePod reward objects
- codePod report logic

Use `codeclip:*` Redis keys and `rewards` with:

- openClip
- clip
- clipPlus
- clipXtra

Do not implement codeClip by extending codePod.
