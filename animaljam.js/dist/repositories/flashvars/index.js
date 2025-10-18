import { Repository } from '../index.js';
import { ANIMAL_JAM_BASE_URL } from '../../Constants.js';

export class FlashvarsRepository extends Repository {
  async fetch() {
    try {
      const response = await this.client.request.send(`${ANIMAL_JAM_BASE_URL}/flashvars`, {
        method: 'GET',
        includeHost: false,
        headers: {
          'User-Agent': 'animaljam.js',
          'Accept': 'application/json',
        },
      });

      // 🧩 Sometimes the server returns HTML (404 page) instead of JSON
      if (
        !response ||
        !response.data ||
        typeof response.data !== 'object' ||
        (typeof response.data === 'string' && response.data.includes('<html>'))
      ) {
        throw new Error('Invalid flashvars response');
      }

      return response.data;
    } catch {
//      console.log('⚠️ Flashvars fetch failed — using static fallback');

      // 🔧 Static fallback (updated for deploy_version 1803)
      return {
        blueboxPort: '443',
        blueboxServer: 'iss02-classic-prod.animaljam.com',
        build_version: '1',
        clientURL: 'https://ajcontent.akamaized.net/1803/ajclient.swf?v=1',
        content: 'https://ajcontent.akamaized.net/',
        country: 'AU',
        deploy_version: '1803',
        locale: 'en',
        mdUrl: 'https://jammercentral.animaljam.com/game/',
        playerWallHost: 'https://prod-wall.animaljam.com/wall',
        sbStatModulator: '16',
        sbStatTrackerIp: 'stats.animaljam.com',
        smartfoxPort: '443',
        smartfoxServer: 'iss02-classic-prod.animaljam.com',
        smoke_version: '1803',
        website: 'https://www.animaljam.com',
      };
    }
  }
}