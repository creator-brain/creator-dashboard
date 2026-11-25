const signoff = '\n\nBest,\n[Your name]'

export const hasTemplateFields = body => /\[[^\]\n]+\]/.test(body)

export const EMAIL_TEMPLATES = [
  {
    id: 'details',
    label: 'Ask for details',
    body: brand => `Hi,\n\nThanks for reaching out about ${brand}. Could you share the campaign brief, deliverables, posting timeline, usage rights, and budget? Once I have those details, I can confirm availability and send my rate.${signoff}`,
  },
  {
    id: 'rates',
    label: 'Share a rate',
    body: brand => `Hi,\n\nThanks for considering me for ${brand}. My rate for [deliverable] is [amount], including [scope of work]. Paid usage, exclusivity, and additional edits can be quoted separately. Please let me know if this fits your budget and timeline.${signoff}`,
  },
  {
    id: 'follow-up',
    label: 'Follow up',
    body: brand => `Hi,\n\nJust following up on our conversation about ${brand}. Have there been any updates on the brief or timeline? Happy to review the details when you're ready.${signoff}`,
  },
  {
    id: 'draft',
    label: 'Submit a draft',
    body: brand => `Hi,\n\nThe draft for ${brand} is ready for your review: [draft link]. Please share any feedback by [date] so I can stay on schedule.${signoff}`,
  },
  {
    id: 'payment',
    label: 'Check payment',
    body: brand => `Hi,\n\nI'm following up on the payment for ${brand}. Could you confirm when it will be processed? I'm happy to resend the invoice or any details you need.${signoff}`,
  },
  {
    id: 'decline',
    label: 'Decline politely',
    body: brand => `Hi,\n\nThanks for considering me for ${brand}. I won't be able to take this one on, but I appreciate you reaching out. Please keep me in mind for future campaigns.${signoff}`,
  },
]
