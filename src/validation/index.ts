import type { CreateDecisionService } from '../shared/contracts.ts';
import { createDecide } from './decide.ts';
import { createDomainResolver } from './domains.ts';

export const createDecisionService: CreateDecisionService = (deps) => ({
  decide: createDecide(deps.resolveDomain ?? createDomainResolver()),
});
