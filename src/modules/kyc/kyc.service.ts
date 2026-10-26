import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { pageMeta, skipTake } from '../../common/dto/pagination.dto.js';
import type { Actor } from '../../common/types/request.js';
import { isUniqueViolation } from '../../infra/prisma/prisma-errors.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { ListKycQueryDto, parseDateOnly, ReviewKycDto, SubmitKycDto } from './dto/kyc.dto.js';
import { toAdminKycView, toKycView } from './kyc.presenter.js';

const pendingConflict = () =>
  AppException.conflict(ErrorCode.KYC_PENDING, 'Your KYC is already submitted and pending review.');

@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * First submission creates the record. After a rejection the customer
   * re-submits in place (back to PENDING). PENDING and VERIFIED records can't
   * be changed. Each transition is a compare-and-set, so concurrent submits
   * can't both win.
   */
  async submit(userId: string, dto: SubmitKycDto, actor: Actor) {
    if ((dto.idType === 'NIN' || dto.idType === 'BVN') && !/^\d{11}$/.test(dto.idNumber)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        `idNumber must be exactly 11 digits for ${dto.idType}`,
        [{ field: 'idNumber', message: `must be exactly 11 digits for ${dto.idType}` }],
      );
    }
    const data = {
      fullName: dto.fullName,
      dateOfBirth: parseDateOnly(dto.dateOfBirth)!,
      address: dto.address,
      idType: dto.idType,
      idNumber: dto.idNumber,
      documentUrl: dto.documentUrl ?? null,
    };

    const existing = await this.prisma.kycRecord.findUnique({ where: { userId } });
    if (existing?.status === 'PENDING') throw pendingConflict();
    if (existing?.status === 'VERIFIED') {
      throw AppException.conflict(ErrorCode.KYC_ALREADY_VERIFIED, 'Your KYC is already verified.');
    }

    try {
      const record = await this.prisma.$transaction(async (tx) => {
        let saved;
        if (existing) {
          const now = new Date();
          const resubmitted = await tx.kycRecord.updateMany({
            where: { id: existing.id, status: 'REJECTED' },
            data: {
              ...data,
              status: 'PENDING',
              rejectionReason: null,
              reviewedById: null,
              reviewedAt: null,
              submittedAt: now,
            },
          });
          if (resubmitted.count !== 1) throw pendingConflict(); // a concurrent re-submit won
          saved = await tx.kycRecord.findUniqueOrThrow({ where: { id: existing.id } });
        } else {
          saved = await tx.kycRecord.create({ data: { ...data, userId } });
        }
        await this.audit.record(
          { action: AuditAction.KYC_SUBMITTED, actor, resourceType: 'kyc', resourceId: saved.id },
          tx,
        );
        return saved;
      });
      return toKycView(record);
    } catch (err) {
      if (isUniqueViolation(err, 'kyc_records_user_id_key')) throw pendingConflict();
      throw err;
    }
  }

  async getMine(userId: string) {
    const kyc = await this.prisma.kycRecord.findUnique({ where: { userId } });
    if (!kyc) throw AppException.notFound(ErrorCode.KYC_NOT_FOUND, 'No KYC record found.');
    return toKycView(kyc);
  }

  async list(query: ListKycQueryDto) {
    const where = query.status ? { status: query.status } : {};
    const [kycs, total] = await Promise.all([
      this.prisma.kycRecord.findMany({
        where,
        include: { user: { select: { id: true, email: true, role: true } } },
        // Oldest first is the natural review queue order for PENDING.
        orderBy: [{ createdAt: query.status === 'PENDING' ? 'asc' : 'desc' }, { id: 'asc' }],
        ...skipTake(query),
      }),
      this.prisma.kycRecord.count({ where }),
    ]);
    return { kycs: kycs.map(toAdminKycView), pagination: pageMeta(total, query) };
  }

  /** Approve or reject a PENDING submission. Decisions are final; admins can't review themselves. */
  async review(kycId: string, dto: ReviewKycDto, actor: Actor & { userId: string }) {
    const record = await this.prisma.kycRecord.findUnique({ where: { id: kycId } });
    if (!record) throw AppException.notFound(ErrorCode.KYC_NOT_FOUND, 'KYC record not found.');
    if (record.userId === actor.userId)
      throw AppException.forbidden('You cannot review your own KYC.');

    const approve = dto.action === 'APPROVE';
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.kycRecord.updateMany({
        where: { id: kycId, status: 'PENDING' },
        data: {
          status: approve ? 'VERIFIED' : 'REJECTED',
          verifiedAt: approve ? now : null,
          rejectionReason: approve ? null : dto.reason || 'Rejected by reviewer',
          reviewedById: actor.userId,
          reviewedAt: now,
        },
      });
      if (changed.count !== 1) {
        throw AppException.conflict(
          ErrorCode.KYC_ALREADY_REVIEWED,
          'This KYC submission has already been reviewed.',
        );
      }
      await this.audit.record(
        {
          action: AuditAction.KYC_REVIEWED,
          actor,
          resourceType: 'kyc',
          resourceId: kycId,
          metadata: { decision: dto.action, subjectUserId: record.userId },
        },
        tx,
      );
      return tx.kycRecord.findUniqueOrThrow({ where: { id: kycId } });
    });
    return toKycView(updated);
  }
}
