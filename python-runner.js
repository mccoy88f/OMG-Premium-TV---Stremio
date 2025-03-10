const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const cron = require('node-cron');

class PythonRunner {
    constructor() {
        this.scriptPath = path.join(__dirname, 'temp_script.py');
        
        // Modifica il percorso per salvare nella directory uploads con timestamp
        this.m3uOutputPath = path.join(__dirname, 'uploads', 'generated_playlist.m3u');
        this.useTimestampInFilename = true; // Flag per abilitare l'uso del timestamp nei nomi file
        
        this.lastExecution = null;
        this.lastError = null;
        this.isRunning = false;
        this.scriptUrl = null;
        this.cronJob = null;
        this.updateInterval = null;
        
        // Crea la directory uploads se non esiste
        if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
            fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
        }
    }

    /**
     * Scarica lo script Python dall'URL fornito
     * @param {string} url - L'URL dello script Python
     * @returns {Promise<boolean>} - true se il download è avvenuto con successo
     */
    async downloadScript(url) {
        try {
            console.log(`\n=== Download script Python da ${url} ===`);
            this.scriptUrl = url;
            
            const response = await axios.get(url, { responseType: 'text' });
            fs.writeFileSync(this.scriptPath, response.data);
            
            console.log('✓ Script Python scaricato con successo');
            return true;
        } catch (error) {
            console.error('❌ Errore durante il download dello script Python:', error.message);
            this.lastError = `Errore download: ${error.message}`;
            return false;
        }
    }

    /**
     * Trova tutti i file M3U o M3U8 nelle directory
     * @returns {string[]} - Array di percorsi dei file M3U trovati
     */
    findAllM3UFiles() {
        try {
            // Cerca nella directory principale
            const dirFiles = fs.readdirSync(__dirname);
            const mainM3UFiles = dirFiles
                .filter(file => file.endsWith('.m3u') || file.endsWith('.m3u8'))
                .map(file => path.join(__dirname, file));
                
            // Cerca anche nella directory uploads
            const uploadsDir = path.join(__dirname, 'uploads');
            if (fs.existsSync(uploadsDir)) {
                const uploadFiles = fs.readdirSync(uploadsDir);
                const uploadM3UFiles = uploadFiles
                    .filter(file => file.endsWith('.m3u') || file.endsWith('.m3u8'))
                    .map(file => path.join(uploadsDir, file));
                    
                return [...mainM3UFiles, ...uploadM3UFiles];
            }
            
            return mainM3UFiles;
        } catch (error) {
            console.error('Errore nella ricerca dei file M3U:', error.message);
            return [];
        }
    }

    /**
     * Elimina eventuali file M3U/M3U8 esistenti dalla directory principale
     */
    cleanupM3UFiles() {
        try {
            // Trova tutti i file M3U e M3U8 nella directory principale
            const dirFiles = fs.readdirSync(__dirname);
            const m3uFiles = dirFiles.filter(file => 
                file.endsWith('.m3u') || file.endsWith('.m3u8')
            );
    
            // Elimina ogni file M3U/M3U8 trovato nella directory principale
            m3uFiles.forEach(file => {
                const fullPath = path.join(__dirname, file);
                try {
                    fs.unlinkSync(fullPath);
                    console.log(`File ${fullPath} eliminato`);
                } catch (e) {
                    console.error(`Errore nell'eliminazione del file ${fullPath}:`, e.message);
                }
            });
    
            // Non eliminare i file nella directory uploads
            // I file in uploads vengono mantenuti appositamente
            
            console.log(`✓ Eliminati ${m3uFiles.length} file M3U/M3U8 dalla directory principale`);
        } catch (error) {
            console.error('❌ Errore nella pulizia dei file M3U:', error.message);
        }
    }

    /**
     * Cerca un percorso di file M3U nell'output dello script
     * @param {string} output - L'output dello script Python
     * @returns {string|null} - Il percorso del file M3U o null se non trovato
     */
    findM3UPathFromOutput(output) {
        // Cerca percorsi che terminano con .m3u o .m3u8
        const m3uPathRegex = /[\w\/\\\.]+\.m3u8?\b/g;
        const matches = output.match(m3uPathRegex);
        
        if (matches && matches.length > 0) {
            return matches[0];
        }
        
        return null;
    }

    /**
     * Aggiunge il canale speciale per la rigenerazione della playlist alla fine del file M3U
     * @returns {boolean} - true se l'operazione è avvenuta con successo
     */
    addRegenerateChannel() {
        try {
            // Ottieni il percorso del file M3U più recente
            const m3uPath = this.getM3UPath();
            
            if (!fs.existsSync(m3uPath)) {
                console.error('❌ File M3U non trovato, impossibile aggiungere canale di rigenerazione');
                return false;
            }
    
            console.log('Aggiunta canale di rigenerazione al file M3U...');
            
            // Leggi il contenuto attuale del file
            const currentContent = fs.readFileSync(m3uPath, 'utf8');
            
            // Prepara l'entry del canale speciale
            const specialChannel = `
#EXTINF:-1 tvg-id="rigeneraplaylistpython" tvg-name="Rigenera Playlist Python" tvg-logo="https://raw.githubusercontent.com/mccoy88f/OMG-TV-Stremio-Addon/refs/heads/main/tv.png" group-title="~SETTINGS~",Rigenera Playlist Python
http://127.0.0.1/regenerate`;
            
            // Verifica se il canale già esiste nel file
            if (currentContent.includes('tvg-id="rigeneraplaylistpython"')) {
                console.log('Il canale di rigenerazione è già presente nel file M3U');
                return true;
            }
            
            // Aggiungi il canale speciale alla fine del file
            fs.appendFileSync(m3uPath, specialChannel);
            console.log(`✓ Canale di rigenerazione aggiunto con successo al file M3U: ${m3uPath}`);
            
            return true;
        } catch (error) {
            console.error('❌ Errore nell\'aggiunta del canale di rigenerazione:', error.message);
            return false;
        }
    }
    
    /**
     * Esegue lo script Python scaricato
     * @returns {Promise<boolean>} - true se l'esecuzione è avvenuta con successo
     */
    /**
     * Genera un nome file con timestamp
     * @returns {string} - Il percorso del file con timestamp
     */
    generateTimestampedFilename() {
        const now = new Date();
        const timestamp = now.getFullYear() + 
                         ('0' + (now.getMonth() + 1)).slice(-2) + 
                         ('0' + now.getDate()).slice(-2) + '_' + 
                         ('0' + now.getHours()).slice(-2) + 
                         ('0' + now.getMinutes()).slice(-2) + 
                         ('0' + now.getSeconds()).slice(-2);
        
        return path.join(__dirname, 'uploads', `generated_playlist_${timestamp}.m3u`);
    }
    async executeScript() {
        if (this.isRunning) {
            console.log('⚠️ Un\'esecuzione è già in corso, attendere...');
            return false;
        }

        if (!fs.existsSync(this.scriptPath)) {
            console.error('❌ Script Python non trovato. Eseguire prima downloadScript()');
            this.lastError = 'Script Python non trovato';
            return false;
        }

        try {
            this.isRunning = true;
            console.log('\n=== Esecuzione script Python ===');
            
            // Elimina eventuali file M3U esistenti ma preserva quelli in uploads
            this.cleanupM3UFiles();
            
            // Controlla se Python è installato
            await execAsync('python3 --version').catch(() => 
                execAsync('python --version')
            );
            
            // Esegui lo script Python
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            const { stdout, stderr } = await execAsync(`${pythonCmd} ${this.scriptPath}`);
            
            if (stderr) {
                console.warn('⚠️ Warning durante l\'esecuzione:', stderr);
            }
            
            console.log('Output script:', stdout);
            
            // Cerca qualsiasi file M3U/M3U8 generato
            const foundFiles = this.findAllM3UFiles();
            
            if (foundFiles.length > 0) {
                console.log(`✓ Trovati ${foundFiles.length} file M3U/M3U8`);
                
                // Prendi il primo file trovato (o specifico, se rilevante)
                const sourcePath = foundFiles[0];
                
                // Assicurati che la directory uploads esista
                const uploadsDir = path.join(__dirname, 'uploads');
                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }
                
                // Genera un nome file con timestamp se l'opzione è abilitata
                let destinationPath = this.m3uOutputPath;
                if (this.useTimestampInFilename) {
                    destinationPath = this.generateTimestampedFilename();
                    // Aggiorna anche il percorso standard per compatibilità
                    this.m3uOutputPath = destinationPath;
                } else {
                    // Se il file destinazione esiste già, eliminalo
                    if (fs.existsSync(this.m3uOutputPath)) {
                        fs.unlinkSync(this.m3uOutputPath);
                    }
                }
                
                // Copia il file nella directory uploads
                if (sourcePath !== destinationPath) {
                    fs.copyFileSync(sourcePath, destinationPath);
                    console.log(`✓ File copiato in "${destinationPath}"`);
                }
                
                // Aggiungi il canale di rigenerazione
                this.addRegenerateChannel();
                
                this.lastExecution = new Date();
                this.lastError = null;
                this.isRunning = false;
                return true;
            } else {
                // Prova a cercare percorsi nel testo dell'output
                const possiblePath = this.findM3UPathFromOutput(stdout);
                if (possiblePath && fs.existsSync(possiblePath)) {
                    // Assicurati che la directory uploads esista
                    const uploadsDir = path.join(__dirname, 'uploads');
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }
                    
                    // Genera un nome file con timestamp se l'opzione è abilitata
                    let destinationPath = this.m3uOutputPath;
                    if (this.useTimestampInFilename) {
                        destinationPath = this.generateTimestampedFilename();
                        // Aggiorna anche il percorso standard per compatibilità
                        this.m3uOutputPath = destinationPath;
                    } else {
                        // Se il file destinazione esiste già, eliminalo
                        if (fs.existsSync(this.m3uOutputPath)) {
                            fs.unlinkSync(this.m3uOutputPath);
                        }
                    }
                    
                    fs.copyFileSync(possiblePath, destinationPath);
                    console.log(`✓ File M3U trovato in ${possiblePath} e copiato in ${destinationPath}`);
                    
                    // Aggiungi il canale di rigenerazione
                    this.addRegenerateChannel();
                    
                    this.lastExecution = new Date();
                    this.lastError = null;
                    this.isRunning = false;
                    return true;
                }
                
                console.error('❌ Nessun file M3U trovato dopo l\'esecuzione dello script');
                this.lastError = 'File M3U non generato dallo script';
                this.isRunning = false;
                return false;
            }
        } catch (error) {
            console.error('❌ Errore durante l\'esecuzione dello script Python:', error.message);
            this.lastError = `Errore esecuzione: ${error.message}`;
            this.isRunning = false;
            return false;
        }
    }

    /**
     * Imposta un aggiornamento automatico dello script con la pianificazione specificata
     * @param {string} timeFormat - Formato orario "HH:MM" o "H:MM"
     * @returns {boolean} - true se la pianificazione è stata impostata con successo
     */
    scheduleUpdate(timeFormat) {
        // Ferma eventuali pianificazioni esistenti
        this.stopScheduledUpdates();
        
        // Validazione del formato orario
        if (!timeFormat || !/^\d{1,2}:\d{2}$/.test(timeFormat)) {
            console.error('❌ Formato orario non valido. Usa HH:MM o H:MM');
            this.lastError = 'Formato orario non valido. Usa HH:MM o H:MM';
            return false;
        }
        
        try {
            // Estrai ore e minuti
            const [hours, minutes] = timeFormat.split(':').map(Number);
            
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
                console.error('❌ Orario non valido. Ore: 0-23, Minuti: 0-59');
                this.lastError = 'Orario non valido. Ore: 0-23, Minuti: 0-59';
                return false;
            }
            
            // Crea una pianificazione cron
            // Se è 0:30, esegui ogni 30 minuti
            // Se è 1:00, esegui ogni ora
            // Se è 12:00, esegui ogni 12 ore
            let cronExpression;
            
            if (hours === 0) {
                // Esegui ogni X minuti
                cronExpression = `*/${minutes} * * * *`;
                console.log(`✓ Pianificazione impostata: ogni ${minutes} minuti`);
            } else {
                // Esegui ogni X ore
                cronExpression = `${minutes} */${hours} * * *`;
                console.log(`✓ Pianificazione impostata: ogni ${hours} ore e ${minutes} minuti`);
            }
            
            this.cronJob = cron.schedule(cronExpression, async () => {
                console.log(`\n=== Esecuzione automatica script Python (${new Date().toLocaleString()}) ===`);
                const success = await this.executeScript();
                
                // Dopo l'esecuzione dello script, aggiorna la cache se necessario
                if (success) {
                    try {
                        // Ottieni le istanze necessarie
                        const config = require('./config');
                        const CacheManager = require('./cache-manager')(config);
                        
                        // Usa l'URL attualmente configurato nella cache
                        const currentM3uUrl = CacheManager.cache.m3uUrl;
                        
                        if (currentM3uUrl) {
                            console.log(`\n=== Ricostruzione cache dopo esecuzione automatica dello script ===`);
                            console.log(`Utilizzo l'URL corrente: ${currentM3uUrl}`);
                            await CacheManager.rebuildCache(currentM3uUrl);
                            console.log(`✓ Cache ricostruita con successo dopo esecuzione automatica`);
                        } else {
                            console.log(`❌ Nessun URL M3U configurato nella cache, impossibile ricostruire`);
                        }
                    } catch (cacheError) {
                        console.error(`❌ Errore nella ricostruzione della cache dopo esecuzione automatica:`, cacheError);
                    }
                }
            });
            
            this.updateInterval = timeFormat;
            console.log(`✓ Aggiornamento automatico configurato: ${timeFormat}`);
            return true;
        } catch (error) {
            console.error('❌ Errore nella pianificazione:', error.message);
            this.lastError = `Errore nella pianificazione: ${error.message}`;
            return false;
        }
    }
    
    /**
     * Ferma gli aggiornamenti pianificati
     */
    stopScheduledUpdates() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
            this.updateInterval = null;
            console.log('✓ Aggiornamento automatico fermato');
            return true;
        }
        return false;
    }

    /**
     * Legge il contenuto del file M3U generato
     * @returns {string|null} - Il contenuto del file M3U o null se non esiste
     */
    getM3UContent() {
        try {
            // Ottieni il percorso del file M3U più recente
            const m3uPath = this.getM3UPath();
            
            if (fs.existsSync(m3uPath)) {
                return fs.readFileSync(m3uPath, 'utf8');
            }
            
            // Se il file più recente non esiste, cerca altri file M3U
            const files = this.findAllM3UFiles();
            if (files.length > 0) {
                return fs.readFileSync(files[0], 'utf8');
            }
            
            return null;
        } catch (error) {
            console.error('❌ Errore nella lettura del file M3U:', error.message);
            return null;
        }
    }

    /**
     * Restituisce il percorso del file M3U generato più recente
     * @returns {string} - Il percorso del file M3U più recente
     */
    getM3UPath() {
        if (this.useTimestampInFilename) {
            // Cerca tutti i file generati con pattern di timestamp
            const uploadsDir = path.join(__dirname, 'uploads');
            if (fs.existsSync(uploadsDir)) {
                const files = fs.readdirSync(uploadsDir)
                    .filter(file => file.startsWith('generated_playlist_') && file.endsWith('.m3u'))
                    .map(file => {
                        const filePath = path.join(uploadsDir, file);
                        return {
                            name: file,
                            path: filePath,
                            time: fs.statSync(filePath).mtime.getTime()
                        };
                    })
                    .sort((a, b) => b.time - a.time); // Ordina per tempo di modifica (più recente prima)
                
                if (files.length > 0) {
                    return files[0].path;
                }
            }
        }
        
        // Fallback al percorso standard
        return this.m3uOutputPath;
    }

    /**
     * Verifica se il file M3U generato esiste
     * @returns {boolean} - true se il file esiste
     */
    isM3UAvailable() {
        return fs.existsSync(this.m3uOutputPath);
    }

    /**
     * Restituisce lo stato attuale
     * @returns {Object} - Lo stato attuale
     */
    getStatus() {
        const m3uFiles = this.findAllM3UFiles();
        
        return {
            isRunning: this.isRunning,
            lastExecution: this.lastExecution ? this.formatDate(this.lastExecution) : 'Mai',
            lastError: this.lastError,
            m3uExists: fs.existsSync(this.m3uOutputPath),
            m3uFiles: m3uFiles.length,
            scriptExists: fs.existsSync(this.scriptPath),
            scriptUrl: this.scriptUrl,
            updateInterval: this.updateInterval,
            scheduledUpdates: this.cronJob !== null
        };
    }

    /**
     * Formatta una data in formato italiano
     * @param {Date} date - La data da formattare
     * @returns {string} - La data formattata
     */
    formatDate(date) {
        return date.toLocaleString('it-IT', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }
}

module.exports = new PythonRunner();
