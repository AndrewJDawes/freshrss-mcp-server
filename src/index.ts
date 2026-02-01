#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import crypto from 'crypto';

// Define interfaces for FreshRSS API responses
interface FreshRSSItem {
  id: string;
  feed_id: number;
  title: string;
  author?: string;
  html: string;
  url: string;
  is_saved: number;
  is_read: number;
  created_on_time: number;
}

interface FreshRSSResponse {
  api_version: number;
  auth: number;
  last_refreshed_on_time: number;
  total_items?: number;
  items?: FreshRSSItem[];
  unread_item_ids?: string;
  saved_item_ids?: string;
  feeds?: any[];
  feeds_groups?: any[];
  groups?: any[];
}

function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
}

// FreshRSS API client class
class FreshRSSClient {
  private apiUrl: string;
  private username: string;
  private password: string;
  private apiKey: string | null = null;

  constructor(apiUrl: string, username: string, password: string) {
    this.apiUrl = apiUrl.replace(/\/$/, ''); // Remove trailing slash
    this.username = username;
    this.password = password;
    // Generate API key for Fever API using MD5(username:password)
    this.apiKey = crypto.createHash('md5').update(`${username}:${password}`).digest('hex');
  }

  private async request<T>(endpoint: string = '', method: string = 'GET', data: any = {}): Promise<T> {
    try {
      // The Fever API requires a POST request with api_key for authentication
      // even for GET-like operations
      const requestData = new URLSearchParams({
        api_key: this.apiKey,
        ...data
      });

      const response = await axios({
        method: 'POST', // Always use POST for Fever API
        url: `${this.apiUrl}/api/fever.php`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: requestData,
      });

      if (!response.data?.api_version) {
        throw new Error('Invalid API response');
      }

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new McpError(
          ErrorCode.InternalError,
          `FreshRSS API error: ${error.response?.data?.error || error.message}`
        );
      }
      throw error;
    }
  }

  // Get feed subscriptions
  async getSubscriptions() {
    return this.request('', 'GET', { feeds: '' });
  }

  // Get feed groups
  async getFeedGroups() {
    return this.request('', 'GET', { groups: '' });
  }

  // Get unread items
  async getUnreadItems(): Promise<FreshRSSResponse> {
    /**
     * IMPORTANT:
     * Calling the Fever API with only `items` returns a limited window (often 50 items).
     * That can miss unread items from other feeds (e.g. YouTube).
     *
     * The correct way is:
     * 1) fetch `unread_item_ids`
     * 2) fetch those entries via `items` + `with_ids`
     */
    const unreadIdsResp = await this.request<FreshRSSResponse>('', 'GET', {
      unread_item_ids: '',
    });

    const unreadIds = String(unreadIdsResp.unread_item_ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const allUnreadItems: FreshRSSItem[] = [];
    for (const batch of chunkArray(unreadIds, 50)) {
      const itemsResp = await this.request<FreshRSSResponse>('', 'GET', {
        items: '',
        with_ids: batch.join(','),
      });
      if (itemsResp.items && Array.isArray(itemsResp.items)) {
        allUnreadItems.push(...itemsResp.items);
      }
    }

    // Ensure we only return unread items (defensive)
    const items = allUnreadItems.filter((item) => item.is_read === 0);

    return {
      api_version: unreadIdsResp.api_version,
      auth: unreadIdsResp.auth,
      last_refreshed_on_time: unreadIdsResp.last_refreshed_on_time,
      total_items: items.length,
      items,
    };
  }

  // Get feed items
  async getFeedItems(feedId: number | string): Promise<FreshRSSResponse> {
    // Ensure feedId is a number as required by the Fever API
    const numericFeedId = typeof feedId === 'string' ? parseInt(feedId, 10) : feedId;

    return this.request<FreshRSSResponse>('', 'GET', {
      items: '',
      // Fever API uses `feed_ids` (plural) to filter by feed
      feed_ids: String(numericFeedId),
    });
  }

  // Mark item as read
  async markAsRead(itemId: string) {
    return this.request('', 'POST', {
      mark: 'item',
      id: itemId,
      as: 'read'
    });
  }

  // Mark item as unread
  async markAsUnread(itemId: string) {
    return this.request('', 'POST', {
      mark: 'item',
      id: itemId,
      as: 'unread'
    });
  }

  // Mark all items in a feed as read
  async markFeedAsRead(feedId: string) {
    return this.request('', 'POST', {
      mark: 'feed',
      id: feedId,
      as: 'read',
      before: Math.floor(Date.now() / 1000)
    });
  }

  // Get specific items by IDs
  async getItems(itemIds: string[]) {
    return this.request('', 'GET', {
      items: '',
      with_ids: itemIds.join(',')
    });
  }
}

// Initialize server
const apiUrl = process.env.FRESHRSS_API_URL;
const username = process.env.FRESHRSS_USERNAME;
const password = process.env.FRESHRSS_PASSWORD;

if (!apiUrl || !username || !password) {
  throw new Error('FRESHRSS_API_URL, FRESHRSS_USERNAME, and FRESHRSS_PASSWORD environment variables are required');
}

const client = new FreshRSSClient(apiUrl, username, password);

const server = new Server(
  {
    name: "freshrss-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_feeds",
      description: "List all feed subscriptions",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_feed_groups",
      description: "Get feed groups",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_unread",
      description: "Get unread items",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_feed_items",
      description: "Get items from a specific feed",
      inputSchema: {
        type: "object",
        properties: {
          feed_id: {
            type: "string",
            description: "Feed ID",
          },
        },
        required: ["feed_id"],
      },
    },
    {
      name: "mark_item_read",
      description: "Mark an item as read",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Item ID to mark as read",
          },
        },
        required: ["item_id"],
      },
    },
    {
      name: "mark_item_unread",
      description: "Mark an item as unread",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Item ID to mark as unread",
          },
        },
        required: ["item_id"],
      },
    },
    {
      name: "mark_feed_read",
      description: "Mark all items in a feed as read",
      inputSchema: {
        type: "object",
        properties: {
          feed_id: {
            type: "string",
            description: "Feed ID to mark as read",
          },
        },
        required: ["feed_id"],
      },
    },
    {
      name: "get_items",
      description: "Get specific items by their IDs",
      inputSchema: {
        type: "object",
        properties: {
          item_ids: {
            type: "array",
            items: {
              type: "string",
            },
            description: "Array of item IDs to get",
          },
        },
        required: ["item_ids"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "list_feeds": {
        const response = await client.getSubscriptions();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "get_feed_groups": {
        const response = await client.getFeedGroups();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "get_unread": {
        const response = await client.getUnreadItems();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "get_feed_items": {
        const { feed_id } = request.params.arguments as { feed_id: string };
        const response = await client.getFeedItems(feed_id);

        // Filter items to only include those from the requested feed
        if (response.items && Array.isArray(response.items)) {
          const numericFeedId = parseInt(feed_id, 10);
          response.items = response.items.filter(
            (item: FreshRSSItem) => String(item.feed_id) === String(numericFeedId)
          );

          // Update total_items count to reflect the filtered items
          if (response.total_items !== undefined) {
            response.total_items = response.items.length;
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "mark_item_read": {
        const { item_id } = request.params.arguments as { item_id: string };
        await client.markAsRead(item_id);
        return {
          content: [{
            type: "text",
            text: `Successfully marked item ${item_id} as read`,
          }],
        };
      }

      case "mark_item_unread": {
        const { item_id } = request.params.arguments as { item_id: string };
        await client.markAsUnread(item_id);
        return {
          content: [{
            type: "text",
            text: `Successfully marked item ${item_id} as unread`,
          }],
        };
      }

      case "mark_feed_read": {
        const { feed_id } = request.params.arguments as { feed_id: string };
        await client.markFeedAsRead(feed_id);
        return {
          content: [{
            type: "text",
            text: `Successfully marked all items in feed ${feed_id} as read`,
          }],
        };
      }

      case "get_items": {
        const { item_ids } = request.params.arguments as { item_ids: string[] };
        const items = await client.getItems(item_ids);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(items, null, 2),
          }],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, String(error));
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('FreshRSS MCP server running on stdio');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
