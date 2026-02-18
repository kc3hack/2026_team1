
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const MDN_BASE_URL = 'https://developer.mozilla.org';
const MDN_SEARCH_API = `${MDN_BASE_URL}/api/v1/search`;

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
    async search(query: string): Promise<DocSearchResult | null> {
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

            // Extract the main content (usually <article>)
            // MDN uses <article class="main-page-content"> or just <main>
            const mainContent = doc.querySelector('article.main-page-content') || doc.querySelector('main') || doc.body;

            if (!mainContent) {
                return 'No content found.';
            }

            // Remove sidebar, nav, footer, scripts if they are inside main (usually they are not, but good to be safe)
            const clutterSelectors = ['.locale-container', '.toc-container', '.metadata', 'aside', 'script', 'style'];
            clutterSelectors.forEach(selector => {
                mainContent.querySelectorAll(selector).forEach(el => el.remove());
            });

            const markdown = this.turndownService.turndown(mainContent.innerHTML);
            return markdown;
        } catch (error) {
            console.error('Error fetching content:', error);
            throw error;
        }
    }
}
