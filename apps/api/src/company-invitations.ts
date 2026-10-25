import { ORPCError } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { CompanyInvitationError, createCompanyInvitations } from "@rakazo/db";

export function companyInvitationService(prisma: PrismaClient) {
  return createCompanyInvitations(prisma);
}

export async function companyInvitationResult<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof CompanyInvitationError) {
      throw new ORPCError(error.code, { message: error.message });
    }
    throw error;
  }
}
