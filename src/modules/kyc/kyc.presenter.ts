import type { KycRecord, User } from '../../generated/prisma/client.js';

export function toKycView(kyc: KycRecord) {
  return {
    id: kyc.id,
    userId: kyc.userId,
    fullName: kyc.fullName,
    dateOfBirth: kyc.dateOfBirth.toISOString().slice(0, 10),
    address: kyc.address,
    idType: kyc.idType,
    idNumber: kyc.idNumber,
    documentUrl: kyc.documentUrl,
    status: kyc.status,
    rejectionReason: kyc.rejectionReason,
    reviewedAt: kyc.reviewedAt?.toISOString() ?? null,
    verifiedAt: kyc.verifiedAt?.toISOString() ?? null,
    submittedAt: kyc.submittedAt.toISOString(),
    createdAt: kyc.createdAt.toISOString(),
    updatedAt: kyc.updatedAt.toISOString(),
  };
}

export function toAdminKycView(kyc: KycRecord & { user: Pick<User, 'id' | 'email' | 'role'> }) {
  return {
    ...toKycView(kyc),
    user: { id: kyc.user.id, email: kyc.user.email, role: kyc.user.role },
  };
}
