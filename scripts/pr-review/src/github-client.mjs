export class GitHubClient {
  constructor({ token, repository, fetchImpl = fetch }) {
    this.token = token
    this.repository = repository
    this.fetch = fetchImpl
  }

  async request(path, options = {}) {
    const response = await this.fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ldb-ai-pr-review',
        ...options.headers
      }
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`GitHub API ${response.status}: ${detail}`)
    }
    const isNoContentResponse = response.status === 204
    return isNoContentResponse ? null : response.json()
  }

  async paginate(path) {
    const results = []
    for (let page = 1; ; page += 1) {
      const hasQuery = path.includes('?')
      const querySeparator = hasQuery ? '&' : '?'
      const items = await this.request(`${path}${querySeparator}per_page=100&page=${page}`)
      results.push(...items)
      const isFinalPage = items.length < 100
      if (isFinalPage) {
        return results
      }
    }
  }

  listComments(number) {
    return this.paginate(`/repos/${this.repository}/issues/${number}/comments`)
  }

  getPullRequest(number) {
    return this.request(`/repos/${this.repository}/pulls/${number}`)
  }

  listFiles(number) {
    return this.paginate(`/repos/${this.repository}/pulls/${number}/files`)
  }

  listCommits(number) {
    return this.paginate(`/repos/${this.repository}/pulls/${number}/commits`)
  }

  async listCommitFiles(sha) {
    const files = []
    for (let page = 1; ; page += 1) {
      const commit = await this.request(
        `/repos/${this.repository}/commits/${sha}?per_page=100&page=${page}`
      )
      const commitFiles = commit.files ?? []
      files.push(...commitFiles)
      const isFinalPage = commitFiles.length < 100
      if (isFinalPage) {
        return files
      }
    }
  }

  createComment(number, body) {
    return this.request(`/repos/${this.repository}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body })
    })
  }

  updateComment(commentId, body) {
    return this.request(`/repos/${this.repository}/issues/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body })
    })
  }
}
