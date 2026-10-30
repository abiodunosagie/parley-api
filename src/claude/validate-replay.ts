// Checks for the parts of Claude's earlier replies that the app sends back so a conversation can
// carry on: web search results (their page content is encrypted by Anthropic) and the sources
// Claude cited. Every field is rebuilt from an allowlist. Pure functions, covered by
// validate.spec.ts.
import type Anthropic from '@anthropic-ai/sdk';
import { type Budget, Invalid, isObject } from './validate-shared.js';

type Block = Anthropic.Beta.BetaContentBlockParam;
type Citation = Anthropic.Beta.BetaTextCitationParam;

export // The results of one earlier search. The page content is encrypted by Anthropic, so the app can
// only hand it back, not change it; the API rejects anything that was altered.
function parseSearchResult(
  block: Record<string, unknown>,
  budget: Budget,
): Block {
  if (typeof block.tool_use_id !== 'string')
    throw new Invalid('Malformed search result.');
  const content = block.content;
  if (isObject(content)) {
    if (
      content.type !== 'web_search_tool_result_error' ||
      typeof content.error_code !== 'string'
    ) {
      throw new Invalid('Malformed search result.');
    }
    return {
      type: 'web_search_tool_result',
      tool_use_id: block.tool_use_id,
      content: {
        type: 'web_search_tool_result_error',
        error_code: content.error_code,
      } as Anthropic.Beta.BetaWebSearchToolRequestError,
    };
  }
  if (!Array.isArray(content)) throw new Invalid('Malformed search result.');
  budget.searchResults += content.length;
  const results = content.map((r) => {
    if (
      !isObject(r) ||
      r.type !== 'web_search_result' ||
      typeof r.url !== 'string' ||
      typeof r.title !== 'string' ||
      typeof r.encrypted_content !== 'string'
    ) {
      throw new Invalid('Malformed search result.');
    }
    budget.textChars += r.url.length + r.title.length;
    budget.opaqueChars += r.encrypted_content.length;
    return {
      type: 'web_search_result' as const,
      url: r.url,
      title: r.title,
      encrypted_content: r.encrypted_content,
      page_age: typeof r.page_age === 'string' ? r.page_age : null,
    };
  });
  return {
    type: 'web_search_tool_result',
    tool_use_id: block.tool_use_id,
    content: results,
  };
}

// A source Claude cited in an earlier reply: a web page, or a page range of the PDF.
export function parseCitation(value: unknown, budget: Budget): Citation {
  if (!isObject(value) || typeof value.cited_text !== 'string')
    throw new Invalid('Malformed citation.');
  // Quotes from the source, not your own words: they count with the opaque data.
  const cited = value.cited_text;
  budget.opaqueChars += cited.length;
  switch (value.type) {
    case 'web_search_result_location':
      if (
        typeof value.url !== 'string' ||
        typeof value.encrypted_index !== 'string'
      ) {
        throw new Invalid('Malformed citation.');
      }
      budget.opaqueChars += value.encrypted_index.length;
      return {
        type: 'web_search_result_location',
        url: value.url,
        title: typeof value.title === 'string' ? value.title : null,
        encrypted_index: value.encrypted_index,
        cited_text: cited,
      };
    case 'page_location':
      if (
        !Number.isInteger(value.document_index) ||
        !Number.isInteger(value.start_page_number) ||
        !Number.isInteger(value.end_page_number)
      ) {
        throw new Invalid('Malformed citation.');
      }
      return {
        type: 'page_location',
        cited_text: cited,
        document_index: value.document_index as number,
        document_title:
          typeof value.document_title === 'string'
            ? value.document_title
            : null,
        start_page_number: value.start_page_number as number,
        end_page_number: value.end_page_number as number,
      };
    default:
      throw new Invalid('Malformed citation.');
  }
}
