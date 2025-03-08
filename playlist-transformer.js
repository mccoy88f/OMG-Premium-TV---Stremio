const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('./config');

async function readExternalFile(url) {
  try {
      // Gestisci i file locali
      if (url.startsWith('file://')) {
          const fs = require('fs');
          const filePath = url.replace('file://', '');
          
          console.log('Lettura file locale:', filePath);
          
          if (!fs.existsSync(filePath)) {
              throw new Error(`File locale non trovato: ${filePath}`);
          }
          
          const content = fs.readFileSync(filePath, 'utf8');
          
          if (content.trim().startsWith('#EXTM3U')) {
              console.log('File M3U diretto trovato (locale)');
              return [url];
          }
          
          console.log('File lista URL trovato (locale)');
          return content.split('\n').filter(line => line.trim() !== '');
      }
      
      // Per URL remote, usa il codice esistente
      const response = await axios.get(url);
      const content = response.data;

      if (content.trim().startsWith('#EXTM3U')) {
          console.log('File M3U diretto trovato');
          return [url];
      }

      console.log('File lista URL trovato');
      return content.split('\n').filter(line => line.trim() !== '');
  } catch (error) {
      console.error('Errore nella lettura del file:', error);
      throw error;
  }
}

class PlaylistTransformer {
  constructor() {
      this.remappingRules = new Map();
      this.channelsMap = new Map();
      this.channelsWithoutStreams = [];
  }

  shouldSkipChannel(channelName) {
    if (!channelName) return false;
    
    // Ignora canali il cui nome inizia con "---" o "==="
    return /^(---|===)/.test(channelName.trim());
  }
  
  normalizeGenreName(genre) {
    if (!genre) return 'Altri Canali';
    
    // Rimuove tutti i caratteri '=' all'inizio e alla fine
    let normalized = genre.trim().replace(/^[=\-]+|[=\-]+$/g, '');

    // Rimuove eventuali spazi in eccesso dopo la rimozione dei caratteri '='
    normalized = normalized.trim();
    
    // Se dopo la normalizzazione il genere è vuoto, restituisci "Altri Canali"
    return normalized || 'Altri Canali';
  }
  
  reset() {
      this.remappingRules = new Map();
      this.channelsMap = new Map();
      this.channelsWithoutStreams = [];
      
      console.log('✓ Stato interno del transformer reimpostato');
  }
  
  normalizeId(id) {
      return id?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
  }

  cleanChannelName(name) {
      return name
          .replace(/[\(\[].*?[\)\]]/g, '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '');
  }

  async loadRemappingRules(config) {
      console.log('Remapper path:', config?.remapper_path);
      const defaultPath = path.join(__dirname, 'link.epg.remapping');
      const remappingPath = config?.remapper_path || defaultPath;
    
      try {
          let content;
          if (remappingPath.startsWith('http')) {
              try {
                  const response = await axios.get(remappingPath);
                  content = response.data;
                  console.log('✓ Download remapping remoto completato');
              } catch (downloadError) {
                  console.error('❌ Download remoto fallito:', downloadError.message);
                  if (downloadError.response) {
                      console.error('Status:', downloadError.response.status);
                      console.error('Headers:', downloadError.response.headers);
                  }
                  console.log('Uso fallback locale:', defaultPath);
                  content = await fs.promises.readFile(defaultPath, 'utf8');
              }
          } else {
              content = await fs.promises.readFile(remappingPath, 'utf8');
          }

          let ruleCount = 0;
          content.split('\n').forEach(line => {
              line = line.trim();
              if (!line || line.startsWith('#')) return;
              const [m3uId, epgId] = line.split('=').map(s => s.trim());
              if (m3uId && epgId) {
                  this.remappingRules.set(this.normalizeId(m3uId), this.normalizeId(epgId));
                  ruleCount++;
              }
          });

          console.log(`✓ Caricate ${ruleCount} regole da ${remappingPath}`);
      } catch (error) {
          console.error('❌ Errore finale remapping:', error.message);
      }
  }

  parseVLCOpts(lines, currentIndex, extinf) {
      let i = currentIndex;
      
      // Debug per vedere il contenuto delle linee
      if (extinf.includes('tvg-name')) {
          const channelName = extinf.match(/tvg-name="([^"]+)"/) 
              ? extinf.match(/tvg-name="([^"]+)"/)[1]
              : 'Canale sconosciuto';
      }
      
      const extinfHeaders = {};
      const extinfopts = extinf.match(/http-[^=]+=["']([^"']+)/g);
      if (extinfopts) {
          extinfopts.forEach(opt => {
              const [key, value] = opt.split('=');
              extinfHeaders[key.replace('http-', '')] = value.replace(/["']/g, '');
          });
      }

      const vlcHeaders = {};
      while (i < lines.length && lines[i].startsWith('#EXTVLCOPT:')) {
          const opt = lines[i].substring('#EXTVLCOPT:'.length).trim();
          const [key, ...value] = opt.split('=');
          const headerKey = key.replace('http-', '');
          vlcHeaders[headerKey] = value.join('=');
          i++;
      }

      const httpHeaders = {};
      if (i < lines.length && lines[i].startsWith('#EXTHTTP:')) {
          try {
              const parsed = JSON.parse(lines[i].substring('#EXTHTTP:'.length));
              Object.assign(httpHeaders, parsed);
              i++;
          } catch (e) {
              console.error('Error parsing EXTHTTP:', e);
          }
      }

      const finalHeaders = {
          ...extinfHeaders,
          ...vlcHeaders,
          ...httpHeaders
      };

      // Unifica user-agent con varie priorità
      finalHeaders['User-Agent'] = httpHeaders['User-Agent'] || httpHeaders['user-agent'] ||
                                  vlcHeaders['user-agent'] || extinfHeaders['user-agent'];

      // Normalizza referrer/referer - preferisci 'referrer' come nome finale
      if (vlcHeaders['referrer']) {
          finalHeaders['referrer'] = vlcHeaders['referrer'];
      } else if (vlcHeaders['referer']) {
          finalHeaders['referrer'] = vlcHeaders['referer'];
      }
      delete finalHeaders['referer'];

      // Normalizza origin
      if (vlcHeaders['origin']) {
          finalHeaders['origin'] = vlcHeaders['origin'];
      }

      // Debug degli header finali

      return { headers: finalHeaders, nextIndex: i };
  }
  
  parseChannelFromLine(line, headers, config) {
    const metadata = line.substring(8).trim();
    const tvgData = {};
  
    const tvgMatches = metadata.match(/([a-zA-Z-]+)="([^"]+)"/g) || [];
    tvgMatches.forEach(match => {
        const [key, value] = match.split('=');
        const cleanKey = key.replace('tvg-', '');
        tvgData[cleanKey] = value.replace(/"/g, '');
    });
  
    const groupMatch = metadata.match(/group-title="([^"]+)"/);
    let genres = [];
    if (groupMatch) {
        genres = groupMatch[1].split(';')
            .map(g => this.normalizeGenreName(g))  // Applica la normalizzazione a ogni genere
            .filter(g => g !== '' && g.toLowerCase() !== 'undefined');
    }
  
    // Se genres è vuoto, usa 'Altri Canali'
    if (genres.length === 0) {
        genres = ['Altri Canali'];
    }
  
    const nameParts = metadata.split(',');
    const name = nameParts[nameParts.length - 1].trim();
  
    if (!tvgData.id) {
        const suffix = config?.id_suffix || '';
        tvgData.id = this.cleanChannelName(name) + (suffix ? `.${suffix}` : '');
    }
  
    return {
        name,
        group: genres,
        tvg: tvgData,
        headers
    };
  }

  getRemappedId(channel) {
      const originalId = channel.tvg.id;
      const suffix = config?.id_suffix || ''; // Ottieni il suffisso dalla configurazione
      const normalizedId = this.normalizeId(originalId) + (suffix ? `.${suffix}` : ''); // Aggiungi il suffisso all'ID normalizzato
      const remappedId = this.remappingRules.get(normalizedId);

      if (remappedId) {
          return this.normalizeId(remappedId);
      }

      return normalizedId; // Restituisci l'ID normalizzato con il suffisso
  }

  createChannelObject(channel, channelId) {
      const name = channel.tvg?.name || channel.name;
      const cleanName = name.replace(/\s*\(.*?\)\s*/g, '').trim();
      const suffix = config?.id_suffix || ''; // Ottieni il suffisso dalla configurazione
      const finalChannelId = channelId + (suffix ? `.${suffix}` : ''); // Aggiungi il suffisso all'ID del canale

      return {
          id: `tv|${finalChannelId}`, // Usa l'ID con il suffisso
          type: 'tv',
          name: cleanName,
          genre: channel.group,
          posterShape: 'square',
          poster: channel.tvg?.logo,
          background: channel.tvg?.logo,
          logo: channel.tvg?.logo,
          description: `Canale: ${cleanName} - ID: ${finalChannelId}`,
          runtime: 'LIVE',
          behaviorHints: {
              defaultVideoId: `tv|${finalChannelId}`,
              isLive: true
          },
          streamInfo: {
              urls: [],
              tvg: {
                  ...channel.tvg,
                  id: finalChannelId,
                  name: cleanName
              }
          }
      };
  }

  addStreamToChannel(channel, url, name, genres, headers) {
      if (genres) {
          genres.forEach(newGenre => {
              if (!channel.genre.includes(newGenre)) {
                  channel.genre.push(newGenre);
              }
          });
      }

      if (url === null || url.toLowerCase() === 'null') {
          channel.streamInfo.urls.push({
              url: 'https://static.vecteezy.com/system/resources/previews/001/803/236/mp4/no-signal-bad-tv-free-video.mp4',
              name: 'Nessuno flusso presente nelle playlist m3u',
              headers
          });
      } else {
          channel.streamInfo.urls.push({
              url,
              name,
              headers
          });
      }
  }
  
  async parseM3UContent(content, config) {
      const lines = content.split('\n');
      let currentChannel = null;
      const genres = new Set(['Altri Canali']);
  
      let epgUrl = null;
      if (lines[0].includes('url-tvg=')) {
          const match = lines[0].match(/url-tvg="([^"]+)"/);
          if (match) {
              epgUrl = match[1].split(',').map(url => url.trim());
              console.log('URL EPG trovati nella playlist:', epgUrl);
          }
      }
  
      for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
      
          if (line.startsWith('#EXTINF:')) {
              // Estrai il nome del canale per verificare se deve essere saltato
              const lineWithoutPrefix = line.substring(8).trim();
              const nameParts = lineWithoutPrefix.split(',');
              const channelName = nameParts[nameParts.length - 1].trim();
              
              if (this.shouldSkipChannel(channelName)) {
                  // Salta questo canale
                  console.log(`⚠️ Canale ignorato: ${channelName}`);
                  currentChannel = null;
                  continue;
              }
              
              const { headers, nextIndex } = this.parseVLCOpts(lines, i + 1, line);
              i = nextIndex - 1;
              currentChannel = this.parseChannelFromLine(line, headers, config);
          
              // Verifica la presenza di User-Agent, Referrer e Origin
              const channelNameLog = currentChannel.tvg?.name || currentChannel.name;
            
          } else if ((line.startsWith('http') || line.toLowerCase() === 'null') && currentChannel) {
              const remappedId = this.getRemappedId(currentChannel);
              const normalizedId = this.normalizeId(remappedId);

              if (!this.channelsMap.has(normalizedId)) {
                  const channelObj = this.createChannelObject(currentChannel, remappedId);
                  this.channelsMap.set(normalizedId, channelObj);
                  currentChannel.group.forEach(genre => genres.add(genre));
              }

              const channelObj = this.channelsMap.get(normalizedId);
              this.addStreamToChannel(channelObj, line, currentChannel.name, currentChannel.group, currentChannel.headers);
  
              currentChannel = null;
          }
      }

      this.channelsWithoutStreams = [];
      for (const [id, channel] of this.channelsMap.entries()) {
          if (channel.streamInfo.urls.length === 0) {
              this.channelsWithoutStreams.push(channel.name);
          }
      }

      if (this.channelsWithoutStreams.length > 0) {
          console.warn(`⚠️ Canali senza flussi riproducibili: ${this.channelsWithoutStreams.length}`);
          console.log('\n=== Canali senza flussi ===');
          this.channelsWithoutStreams.forEach(name => {
              console.log(`${name}`);
          });
          console.log('========================\n');
      }

      const channelsWithOnlyDummy = [];
      for (const [id, channel] of this.channelsMap.entries()) {
          if (channel.streamInfo.urls.length === 1 && 
              channel.streamInfo.urls[0].name === 'Nessuno flusso presente nelle playlist m3u') {
              channelsWithOnlyDummy.push(channel.name);
          }
      }

      if (channelsWithOnlyDummy.length > 0) {
          console.log('\n=== Canali con solo flusso dummy ===');
          channelsWithOnlyDummy.forEach(name => {
              console.log(`${name}`);
          });
          console.log(`✓ Totale canali con solo flusso dummy: ${channelsWithOnlyDummy.length}`);
          console.log('================================\n');
      }

      return {
          genres: Array.from(genres),
          epgUrl
      };
  }

  async loadAndTransform(url, config = {}) {
      try {
          // Reset all'inizio dell'operazione
          this.remappingRules = new Map();
          this.channelsMap = new Map();
          this.channelsWithoutStreams = [];
          
          await this.loadRemappingRules(config);
          
          // Raccogli le URL delle playlist
          let playlistUrls = [];
          
          // 1. Gestisci URL principale
          if (url.startsWith('file://')) {
              // Logica per file locale
              const fs = require('fs');
              
              // Rimuovi eventuali parametri di query dall'URL del file
              const cleanUrl = url.split('?')[0];
              
              // Controlla se c'è un doppio file:// e correggi
              let filePath;
              if (cleanUrl.startsWith('file://file://')) {
                  // Rimuovi il doppio prefisso
                  filePath = cleanUrl.replace('file://file://', '');
              } else {
                  // Rimuovi il prefisso singolo
                  filePath = cleanUrl.replace('file://', '');
              }
              
              console.log('\n=== Lettura file locale ===');
              console.log('Percorso originale:', url);
              console.log('Percorso pulito:', filePath);
              
              if (!fs.existsSync(filePath)) {
                  throw new Error(`File locale non trovato: ${filePath}`);
              }
              
              // Leggi il file fresco dal disco, non dalla cache
              const content = fs.readFileSync(filePath, 'utf8', {
                  // Opzioni per evitare la cache dei file
                  flag: 'r', // 'r' apre il file in modalità lettura
                  encoding: 'utf8'
              });
              
              console.log(`✓ File locale letto: ${content.length} bytes`);
              
              if (content.trim().startsWith('#EXTM3U')) {
                  playlistUrls = [url.split('?')[0]]; // rimuovi i parametri di query
              } else {
                  // Se contiene liste di URL, usa quelli
                  playlistUrls = content.split('\n')
                      .filter(line => line.trim() && (line.trim().startsWith('http') || line.trim().startsWith('https')));
                      
                  console.log(`✓ Trovate ${playlistUrls.length} URL nel file locale`);
              }
          } else {
              // Usa il metodo esistente per URL remote
              const response = await axios.get(url);
              const content = response.data;
              playlistUrls = content.startsWith('#EXTM3U') 
                  ? [url] 
                  : content.split('\n').filter(line => line.trim() && line.startsWith('http'));
          }
    
          // 2. Aggiungi la playlist Python generata SOLO se il flag è attivo
          if (config.include_python_playlist === true || config.include_python_playlist === 'true') {
              const path = require('path');
              const fs = require('fs');
              const PythonRunner = require('./python-runner');
              
              const pythonM3UPath = PythonRunner.getM3UPath();
              
              if (fs.existsSync(pythonM3UPath)) {
                  console.log('✓ Aggiunta playlist Python generata:', pythonM3UPath);
                  playlistUrls.push(`file://${pythonM3UPath}`);
              } else {
                  console.log('⚠️ Playlist Python richiesta ma non trovata');
              }
          }
    
          console.log('\n=== Inizio Processamento Playlist ===');
          console.log('Playlist da processare:', playlistUrls.length);
    
          const allGenres = [];
          const allEpgUrls = new Set();
          
          for (const playlistUrl of playlistUrls) {
              console.log('\nProcesso playlist:', playlistUrl);
              
              try {
                  let playlistData;
                  
                  // Gestisci URL locali e remote
                  if (playlistUrl.startsWith('file://')) {
                      const fs = require('fs');
                      
                      // Controlla se c'è un doppio file:// e correggi
                      let filePath;
                      if (playlistUrl.startsWith('file://file://')) {
                          filePath = playlistUrl.replace('file://file://', '');
                      } else {
                          filePath = playlistUrl.replace('file://', '');
                      }
                      
                      playlistData = fs.readFileSync(filePath, 'utf8');
                  } else {
                      const playlistResponse = await axios.get(playlistUrl);
                      playlistData = playlistResponse.data;
                  }
                  
                  const result = await this.parseM3UContent(playlistData, config);
                  
                  result.genres.forEach(genre => {
                      if (!allGenres.includes(genre)) {
                          allGenres.push(genre);
                      }
                  });
                  
                  if (result.epgUrl) {
                      if (Array.isArray(result.epgUrl)) {
                          result.epgUrl.forEach(url => allEpgUrls.add(url));
                      } else {
                          allEpgUrls.add(result.epgUrl);
                      }
                  }
              } catch (playlistError) {
                  console.error(`❌ Errore nel processamento della playlist ${playlistUrl}:`, playlistError.message);
              }
          }
    
          const finalResult = {
              genres: allGenres,
              channels: Array.from(this.channelsMap.values()),
              epgUrls: Array.from(allEpgUrls)
          };
    
          finalResult.channels.forEach(channel => {
              if (channel.streamInfo.urls.length > 1) {
                  channel.streamInfo.urls = channel.streamInfo.urls.filter(
                      stream => stream.name !== 'Nessuno flusso presente nelle playlist m3u'
                  );
              }
          });
    
          console.log('\nRiepilogo Processamento:');
          console.log(`✓ Totale canali processati: ${finalResult.channels.length}`);
          console.log(`✓ Totale generi trovati: ${finalResult.genres.length}`);
          if (allEpgUrls.size > 0) {
              console.log(`✓ URL EPG trovati: ${allEpgUrls.size}`);
          }
          console.log('=== Processamento Completato ===\n');
    
          this.channelsMap.clear();
          this.channelsWithoutStreams = [];
          return finalResult;
    
      } catch (error) {
          console.error('❌ Errore playlist:', error.message);
          throw error;
      }
  }
}

module.exports = PlaylistTransformer;
