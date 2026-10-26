# Adding a module

Every feature follows the same slice. Use `beneficiaries` (a customer's saved
recipients) as the example.

## 1. Schema

Add the model to `prisma/schema.prisma` (snake_case `@@map`/`@map`, `@db.Uuid` ids with
`@default(uuid(7))`, `Timestamptz(3)` timestamps, `BigInt` for any money), then:

```bash
npx prisma migrate dev --name beneficiaries   # creates and applies the migration
npm run db:generate
```

Put invariants Prisma can't express (`CHECK`s, triggers) in the generated SQL file
before applying it, or in a follow-up migration created with `--create-only`.

## 2. Module files

```text
src/modules/beneficiaries/
  dto/beneficiary.dto.ts        class-validator + @ApiProperty: the request contract
  beneficiary.presenter.ts      row → public JSON (money → string, dates → ISO)
  beneficiaries.service.ts      business rules; throws AppException with a stable code
  beneficiaries.controller.ts   HTTP only
  beneficiaries.module.ts
```

**DTO.** Trim strings with `@Trim()`, reject control characters with
`@HasNoControlChars()`, use `@IsMinorAmount()` for money, and give every field an
explicit message. Unknown fields are rejected globally.

**Service.** Inject `PrismaService`. For anything that changes state and matters, use
`prisma.$transaction(async (tx) => …)` and pass `tx` to `AuditService.record()`. Never
update a balance directly: money only moves through `LedgerService` (`lockWallets` then
`post`), and money-moving endpoints take an `@IdempotencyKey()` claimed with
`IdempotencyService` inside the same transaction.

**Errors.** Throw `AppException.notFound(ErrorCode.X, '…')` and friends. Add new codes
to `ErrorCode` in `src/common/errors/app.exception.ts`. Clients branch on codes, so never
change an existing one.

**Controller.**

```ts
@ApiTags('Beneficiaries')
@ApiBearerAuth()
@Controller('beneficiaries')
export class BeneficiariesController {
  constructor(private readonly beneficiaries: BeneficiariesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ResponseMessage('Beneficiary saved')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBeneficiaryDto) {
    return this.beneficiaries.create(user.id, dto);
  }
}
```

Routes are authenticated by default. Mark public ones with `@Public()`, restrict roles
with `@Roles('ADMIN')`, and apply a `ThrottlePolicy` where abuse is plausible. Look up
resources **scoped to the caller** (`where: { id, userId }`) so someone else's resource
is a 404, never a 403 that reveals it exists.

## 3. Register

Import the module in `src/app.module.ts`, alongside the other features.

## 4. Test

- **Unit** (`*.spec.ts` next to the code): pure logic, no infrastructure.
- **e2e** (`test/*.e2e-spec.ts`): use `TestApp` from `test/support/app.ts`. It boots the real app against the test database, and `reset()`, `customer()`, `admin()` and `fund()` set up state. Cover the happy path, validation, authorization (another user → 404/403) and, for anything touching money, concurrency and idempotency.

```bash
npm test && npm run test:e2e && npm run lint && npm run typecheck
```

## 5. Document

Add the endpoints to the README's API table. Swagger picks up the DTOs and decorators
automatically at `/docs`.
