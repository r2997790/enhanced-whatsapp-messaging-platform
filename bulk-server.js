        
        // Start bulk sending
        const results = await sendBulkMessages(phoneNumbers, message, delay, socket);
        
        // Emit completion
        socket.emit('bulk_completed', {
            results: results,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error in bulk send:', error);
        socket.emit('bulk_failed', {
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Add bulk status endpoint
socket.on('get_bulk_status', () => {
    const activeBulk = Array.from(activeBulkSends).find(queueId => {
        const job = bulkQueue.get(queueId);
        return job && job.socketId === socket.id;
    });
    
    socket.emit('bulk_status', {
        hasActiveBulk: !!activeBulk,
        queueSize: bulkQueue.size,
        activeSends: activeBulkSends.size,
        timestamp: new Date().toISOString()
    });
});

// Export functions for use in main server file
module.exports = {
    sendBulkMessages,
    validateBulkRequest,
    addToBulkQueue,
    processBulkQueue
};