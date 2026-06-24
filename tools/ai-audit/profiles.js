/* ----------------------------------------------------------------------------
   profiles.js — single source of truth for scoring profile definitions.
   Imported by scorer.js. Never imported directly by worker.js.

   Each profile contains:
     name         — machine identifier (matches PROFILES key)
     description  — human-readable summary
     weights      — three keys summing to 100 (not yet applied to output)
     calibration  — baseline expectations for this profile type
---------------------------------------------------------------------------- */

export const PROFILES = {

  smb_lead_gen: {
    name: 'smb_lead_gen',
    description: 'Small or growing business targeting cold prospects to generate leads',
    weights: { positioning: 50, seo: 30, agent: 20 },
    calibration: {
      hookFailureIsCritical: true,
      seoBaselineGrade: 'C',
      agentBaselineLevel: 'EMERGING',
      authorityPenaltyReduced: true,
    },
  },

  smb_authority: {
    name: 'smb_authority',
    description: 'Small or growing business focused on building authority and credibility',
    weights: { positioning: 30, seo: 40, agent: 30 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'C',
      agentBaselineLevel: 'EMERGING',
      authorityPenaltyReduced: true,
    },
  },

  smb_mixed: {
    name: 'smb_mixed',
    description: 'Small or growing business with mixed audiences and multiple goals',
    weights: { positioning: 40, seo: 35, agent: 25 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'C',
      agentBaselineLevel: 'EMERGING',
      authorityPenaltyReduced: true,
    },
  },

  mid_lead_gen: {
    name: 'mid_lead_gen',
    description: 'Established or mid-market firm targeting cold prospects to generate leads',
    weights: { positioning: 40, seo: 40, agent: 20 },
    calibration: {
      hookFailureIsCritical: true,
      seoBaselineGrade: 'B',
      agentBaselineLevel: 'CAPABLE',
      authorityPenaltyReduced: false,
    },
  },

  mid_authority: {
    name: 'mid_authority',
    description: 'Established or mid-market firm focused on authority and institutional credibility',
    weights: { positioning: 25, seo: 45, agent: 30 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'B',
      agentBaselineLevel: 'CAPABLE',
      authorityPenaltyReduced: false,
    },
  },

  mid_client_service: {
    name: 'mid_client_service',
    description: 'Established or mid-market firm primarily serving existing clients and relationships',
    weights: { positioning: 20, seo: 40, agent: 40 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'B',
      agentBaselineLevel: 'CAPABLE',
      authorityPenaltyReduced: false,
    },
  },

  mid_mixed: {
    name: 'mid_mixed',
    description: 'Established or mid-market firm with mixed audiences and multiple goals',
    weights: { positioning: 25, seo: 45, agent: 30 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'B',
      agentBaselineLevel: 'CAPABLE',
      authorityPenaltyReduced: true,
    },
  },

  enterprise_benchmark: {
    name: 'enterprise_benchmark',
    description: 'Large national or global brand routed to enterprise scoring path',
    weights: { positioning: 20, seo: 40, agent: 40 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'A',
      agentBaselineLevel: 'CAPABLE',
      authorityPenaltyReduced: false,
    },
  },

  nonprofit_inform: {
    name: 'nonprofit_inform',
    description: 'Nonprofit or mission-driven organization focused on informing and educating',
    weights: { positioning: 20, seo: 35, agent: 45 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'C',
      agentBaselineLevel: 'EMERGING',
      authorityPenaltyReduced: true,
    },
  },

  nonprofit_leads: {
    name: 'nonprofit_leads',
    description: 'Nonprofit or mission-driven organization focused on donor conversion and authority',
    weights: { positioning: 35, seo: 40, agent: 25 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'C',
      agentBaselineLevel: 'EMERGING',
      authorityPenaltyReduced: true,
    },
  },

  competitor_smb: {
    name: 'competitor_smb',
    description: 'Comparison site inheriting the primary site SMB profile',
    weights: { positioning: 40, seo: 35, agent: 25 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'C',
      agentBaselineLevel: 'EMERGING',
      authorityPenaltyReduced: true,
    },
  },

  competitor_enterprise: {
    name: 'competitor_enterprise',
    description: 'Comparison site inheriting the enterprise profile',
    weights: { positioning: 20, seo: 40, agent: 40 },
    calibration: {
      hookFailureIsCritical: false,
      seoBaselineGrade: 'A',
      agentBaselineLevel: 'CAPABLE',
      authorityPenaltyReduced: false,
    },
  },

};

/* ----------------------------------------------------------------------------
   resolveProfile(userContext)
   Maps the three intake fields onto a named profile.
   userContext shape: { entityType: string|null, primaryVisitor: string[], siteGoal: string[] }
   Always returns a profile object — falls back to smb_mixed on null/unknown input.
---------------------------------------------------------------------------- */
export function resolveProfile(userContext) {
  const ctx = userContext || {};
  const entity   = ctx.entityType    || null;
  const visitors = ctx.primaryVisitor || [];
  const goals    = ctx.siteGoal       || [];

  const hasVisitor = v => visitors.includes(v);
  const hasGoal    = g => goals.includes(g);

  // Large national/global brand → enterprise benchmark
  if (entity === 'large_national_global') return PROFILES.enterprise_benchmark;

  // Nonprofit or mission-driven
  if (entity === 'nonprofit_gov_media') {
    if (hasGoal('inform_educate')) return PROFILES.nonprofit_inform;
    return PROFILES.nonprofit_leads;
  }

  // Small or growing business
  if (entity === 'small_growing') {
    if (hasVisitor('cold_prospects') && hasGoal('generate_leads') && goals.length === 1) return PROFILES.smb_lead_gen;
    if (hasGoal('build_authority') && goals.length === 1) return PROFILES.smb_authority;
    return PROFILES.smb_mixed;
  }

  // Established or mid-market
  if (entity === 'midmarket_regional') {
    if (hasVisitor('cold_prospects') && hasGoal('generate_leads') && goals.length === 1) return PROFILES.mid_lead_gen;
    if (hasGoal('build_authority') && hasVisitor('investors'))                           return PROFILES.mid_authority;
    if (hasVisitor('existing_clients') && hasGoal('serve_relationships'))                return PROFILES.mid_client_service;
    return PROFILES.mid_mixed;
  }

  return PROFILES.smb_mixed;
}

/* ----------------------------------------------------------------------------
   resolveCompareProfile(primaryProfile)
   Returns the appropriate competitor profile based on the primary profile type.
---------------------------------------------------------------------------- */
export function resolveCompareProfile(primaryProfile) {
  if (primaryProfile && primaryProfile.name && primaryProfile.name.includes('enterprise')) {
    return PROFILES.competitor_enterprise;
  }
  return PROFILES.competitor_smb;
}
