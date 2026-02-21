
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const MDN_BASE_URL = 'https://developer.mozilla.org';
const MDN_SEARCH_API = `${MDN_BASE_URL}/api/v1/search`;
//devDocsから対応言語を選抜
const devDocsSlugs: Record<string, string> = {
    'python': 'python~3.14',
    'java': 'openjdk~25',
    'c': 'c',
    'cpp': 'cpp',
    'go': 'go',
    'php': 'php',
    'ruby': 'ruby~4.0',
    'rust': 'rust',
    'kotlin': 'kotlin~1.9',
    'dart': 'dart~2',
    'javascriptreact': 'react',
    'typescriptreact': 'react',
    'vue': 'vue~3',
}

export interface DocSearchResult {
    title: string;
    url: string;
    summary: string;
}

export class DocService {
    private turndownService: TurndownService;

    constructor() {
        this.turndownService = new TurndownService();
        // Configure turndown to keep code blocks and remove mostly clutter
        this.turndownService.addRule('remove-hidden', {
            filter: (node) => {
                return (node as HTMLElement).style?.display === 'none' ||
                    node.classList?.contains('hidden') ||
                    node.classList?.contains('visually-hidden');
            },
            replacement: () => ''
        });
    }

    /**
     * Search MDN for the given keyword/query.
     * Returns the top result or null if not found.
     */

    async search(query: string, language: string): Promise<DocSearchResult | null> {
        const slug = devDocsSlugs[language];
        //MDNで対応している言語はMDNで検索、それ以外はdevDocsで検索
        switch (language) {
            case 'javascript':
            case 'typescript':
            case 'html':
            case 'css':
                try {
                    const searchUrl = `${MDN_SEARCH_API}?q=${encodeURIComponent(query)}`;
                    console.log(`Searching MDN: ${searchUrl}`);

                    const response = await fetch(searchUrl);
                    if (!response.ok) {
                        console.error(`MDN Search failed: ${response.status} ${response.statusText}`);
                        return null;
                    }

                    const data = await response.json() as any;
                    if (data.documents && data.documents.length > 0) {
                        const topDoc = data.documents[0];
                        return {
                            title: topDoc.title,
                            url: `${MDN_BASE_URL}${topDoc.mdn_url}`,
                            summary: topDoc.summary
                        };
                    }

                    return null;
                } catch (error) {
                    console.error('Error searching MDN:', error);
                    return null;
                }
            default:
                if (slug) {
                    try {
                        const indexUrl = `https://devdocs.io/docs/${slug}/index.json`;
                        console.log(`[DevDocs] Fetching index for ${language}: ${indexUrl}`);
                        const res = await fetch(indexUrl);
                        if (!res.ok) {
                            console.error(`DevDocs index search failed: ${res.status}`);
                            return null;
                        }

                        //対応するメソッドやクラスを検索
                        const index = await res.json() as any;
                        const entry = index.entries.find((e: any) =>
                            e.name === query || e.name === `${query}()` || e.name.startsWith(query)
                        );

                        if (entry) {
                            const [pagePath, hash] = entry.path.split('#');
                            // We construct a special URL that includes the hash so fetchContent can extract the specific part
                            const docUrl = `https://documents.devdocs.io/${slug}/${pagePath}.html${hash ? '#' + hash : ''}`;
                            return {
                                title: entry.name,
                                url: docUrl,
                                summary: `Documentation from DevDocs for ${language}`
                            };
                        }
                        return null;
                    } catch (error) {
                        console.error('Error searching DevDocs:', error);
                        return null;
                    }
                }
                //対応していない場合
                throw new Error(`Language "${language}" is not supported.`);
        }
    }

    /**
     * Fetch and parse the content of the documentation page.
     * Returns Markdown string.
     */
    async fetchContent(url: string): Promise<string> {
        try {
            console.log(`Fetching content from: ${url}`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch content: ${response.status}`);
            }

            const html = await response.text();
            const dom = new JSDOM(html);
            const doc = dom.window.document;

            let mainContent: HTMLElement | null = null;

            // URLにハッシュがあるかチェック
            const hashIndex = url.indexOf('#');
            if (hashIndex !== -1) {
                const hash = url.substring(hashIndex + 1);
                console.log(`[DevDocs Extract] Attempting to extract element with id="${hash}"`);
                const targetElement = doc.getElementById(hash);

                if (targetElement) {
                    // For DevDocs (like Python), specific entries are often a <dt> and following <dd>s
                    const wrapper = doc.createElement('div');
                    wrapper.appendChild(targetElement.cloneNode(true));

                    let next = targetElement.nextElementSibling;
                    // Gather subsequent sibling description elements until the next definition
                    while (next && next.tagName !== 'DT' && next.tagName !== 'DL' && next.tagName !== 'H1' && next.tagName !== 'H2' && next.tagName !== 'H3') {
                        wrapper.appendChild(next.cloneNode(true));
                        next = next.nextElementSibling;
                    }
                    mainContent = wrapper;
                    console.log(mainContent);
                    console.log(mainContent.innerHTML);
                }
            }

            // Fallback to standard MDN extraction if no hash or hash element wasn't found
            if (!mainContent) {
                mainContent = doc.querySelector('article.main-page-content') || doc.querySelector('main') || doc.body;
            }

            if (!mainContent) {
                return 'No content found.';
            }

            // Remove sidebar, nav, footer, scripts if they are inside main (usually they are not, but good to be safe)
            const clutterSelectors = ['.locale-container', '.toc-container', '.metadata', 'aside', 'script', 'style'];
            clutterSelectors.forEach(selector => {
                // Ignore errors if elements don't exist
                try {
                    mainContent?.querySelectorAll(selector).forEach(el => el.remove());
                } catch (e) { }
            });

            const markdown = this.turndownService.turndown(mainContent.innerHTML);
            return markdown;
        } catch (error) {
            console.error('Error fetching content:', error);
            throw error;
        }
    }
}
