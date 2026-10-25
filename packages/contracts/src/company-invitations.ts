import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

const tokenInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const companyInvitationsContract = {
  capabilities: oc.output(z.object({ canInvite: z.boolean() })),
  create: oc
    .input(z.object({}))
    .output(z.object({ id: Id, token: tokenInput.shape.token, expiresAt: IsoDate })),
  preview: oc.input(tokenInput).output(
    z.object({
      organizationName: z.string(),
      spaceName: z.string(),
      expiresAt: IsoDate,
    }),
  ),
  accept: oc.input(tokenInput).output(z.object({ organizationId: Id, spaceId: Id })),
  revoke: oc.input(z.object({ invitationId: Id })).output(z.object({ ok: z.literal(true) })),
};
