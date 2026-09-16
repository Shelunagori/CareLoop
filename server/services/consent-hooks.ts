import type { ConsentTurnHooks } from "./conversation";
import { handleConsentReply, prepareOffer, type ConsentDeps } from "./consent";
import { acknowledgeClosure, loadPendingClosure, type ClosureDeps } from "./closure";

export type { ConsentDeps };

export type ConsentTurnHooksSource = {
  consent: ConsentDeps;
  closure: ClosureDeps;
};

/**
 * Binds the M5 services into the four functions a conversational turn needs.
 *
 * The composition lives here rather than in the conversation service so that
 * the hot path depends on an interface it can be tested against, not on the
 * family loop's repositories.
 */
export function buildConsentHooks(source: ConsentTurnHooksSource): ConsentTurnHooks {
  return {
    readReply: (input) => handleConsentReply(source.consent, input),
    prepareOffer: (input) => prepareOffer(source.consent, input),
    loadClosure: (input) => loadPendingClosure(source.closure, input),
    acknowledgeClosure: async (input) => {
      await acknowledgeClosure(source.closure, input);
    },
  };
}
