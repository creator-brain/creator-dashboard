export const metricCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null

export function creatorAccount(platform, { username, followers, following, posts, likes }) {
  return {
    platform,
    username: typeof username === 'string' ? username : '',
    followers: metricCount(followers),
    following: metricCount(following),
    posts: metricCount(posts),
    likes: metricCount(likes),
  }
}

export function contentMetrics({ views, reach, likes, comments, shares, saves, clicks }) {
  return { views: metricCount(views), reach: metricCount(reach), likes: metricCount(likes),
    comments: metricCount(comments), shares: metricCount(shares), saves: metricCount(saves), clicks: metricCount(clicks) }
}

export function combinedAudience(accounts) {
  if (accounts.length < 2 || accounts.some(account => account.followers == null)) return null
  return accounts.reduce((total, account) => total + account.followers, 0)
}
