        // Enhanced Bulk Messaging Functions
        let bulkSending = false;
        let bulkStats = {
            total: 0,
            sent: 0,
            failed: 0,
            current: 0
        };

        // Enhanced bulk message form handler with validation
        document.getElementById('bulk-message-form').addEventListener('submit', function(e) {
            e.preventDefault();
            
            if (bulkSending) {
                showStatus('⏳ Bulk sending already in progress. Please wait...', 'error');
                return;
            }
            
            const phones = document.getElementById('bulk-phones').value.trim();
            const message = document.getElementById('bulk-message').value.trim();
            const delay = parseInt(document.getElementById('delay').value) || 5;
            
            // Validation
            if (!phones || !message) {
                showStatus('❌ Please fill in all required fields', 'error');
                return;
            }
            
            if (message.length > 4000) {
                showStatus('❌ Message is too long (max 4000 characters)', 'error');
                return;
            }
            
            const phoneList = parsePhoneNumbers(phones);
            if (phoneList.length === 0) {
                showStatus('❌ No valid phone numbers found', 'error');
                return;
            }
            
            if (phoneList.length > 50) {
                showStatus('❌ Maximum 50 recipients allowed per batch', 'error');
                return;
            }
            
            if (delay < 3) {
                showStatus('❌ Minimum delay is 3 seconds to avoid being blocked', 'error');
                return;
            }
            
            // Confirm before sending
            if (!confirm(`Send message to ${phoneList.length} recipients with ${delay}s delay between messages?`)) {
                return;
            }
            
            startBulkSending(phoneList, message, delay);
        });

        // Enhanced phone number parsing with validation
        function parsePhoneNumbers(input) {
            const phones = input.split(/[,\\n\\r]+/)
                .map(phone => phone.trim())
                .filter(phone => phone.length > 0)
                .map(phone => {
                    // Remove any non-digit characters except +
                    const cleaned = phone.replace(/[^\\d+]/g, '');
                    // Remove + if present
                    return cleaned.replace(/\\+/g, '');
                })
                .filter(phone => {
                    // Validate phone number (10-15 digits)
                    return phone.length >= 10 && phone.length <= 15 && /^\\d+$/.test(phone);
                });
            
            // Remove duplicates
            return [...new Set(phones)];
        }

        // Preview recipients function
        function previewRecipients() {
            const phones = document.getElementById('bulk-phones').value.trim();
            
            if (!phones) {
                showStatus('❌ Please enter phone numbers first', 'error');
                return;
            }
            
            const phoneList = parsePhoneNumbers(phones);
            const previewDiv = document.getElementById('recipients-preview');
            const previewList = document.getElementById('preview-list');
            const previewCount = document.getElementById('preview-count');
            
            if (phoneList.length === 0) {
                showStatus('❌ No valid phone numbers found', 'error');
                previewDiv.style.display = 'none';
                return;
            }
            
            // Show preview
            previewList.innerHTML = phoneList.map((phone, index) => `
                <div style="background: white; padding: 8px 12px; margin: 4px 0; border-radius: 5px; border-left: 3px solid #25D366; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 500;">📱 +${phone}</span>
                    <button onclick="removeRecipient(${index})" style="background: #dc3545; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 10px; cursor: pointer;" title="Remove">×</button>
                </div>
            `).join('');
            
            previewCount.textContent = phoneList.length;
            previewDiv.style.display = 'block';
            
            showStatus(`✅ Found ${phoneList.length} valid recipients`, 'success');
        }

        // Remove recipient function
        function removeRecipient(index) {
            const phones = document.getElementById('bulk-phones').value.trim();
            const phoneList = parsePhoneNumbers(phones);
            
            phoneList.splice(index, 1);
            document.getElementById('bulk-phones').value = phoneList.join('\\n');
            
            if (phoneList.length > 0) {
                previewRecipients();
            } else {
                document.getElementById('recipients-preview').style.display = 'none';
                showStatus('✅ Recipient removed', 'success');
            }
        }

        // Clear bulk form function
        function clearBulkForm() {
            if (bulkSending) {
                if (!confirm('Bulk sending is in progress. Are you sure you want to clear the form?')) {
                    return;
                }
            }
            
            document.getElementById('bulk-message-form').reset();
            document.getElementById('recipients-preview').style.display = 'none';
            document.getElementById('bulk-progress').style.display = 'none';
            document.getElementById('delay').value = 5;
            
            // Reset bulk sending state
            bulkSending = false;
            bulkStats = { total: 0, sent: 0, failed: 0, current: 0 };
            
            showStatus('✅ Form cleared', 'success');
        }

        // Start bulk sending with progress tracking
        async function startBulkSending(phoneList, message, delay) {
            bulkSending = true;
            bulkStats = {
                total: phoneList.length,
                sent: 0,
                failed: 0,
                current: 0
            };
            
            // Show progress section
            const progressDiv = document.getElementById('bulk-progress');
            progressDiv.style.display = 'block';
            
            // Update initial stats
            updateBulkProgress();
            
            showStatus(`📤 Starting bulk send to ${phoneList.length} recipients...`, 'success');
            
            // Send messages with delay
            for (let i = 0; i < phoneList.length; i++) {
                if (!bulkSending) {
                    showStatus('⏹️ Bulk sending stopped by user', 'error');
                    break;
                }
                
                const phone = phoneList[i];
                bulkStats.current = i + 1;
                
                // Update current sending display
                document.getElementById('current-number').textContent = `Sending to +${phone} (${bulkStats.current}/${bulkStats.total})`;
                
                try {
                    // Send message via socket
                    await sendBulkMessage(phone, message);
                    
                    // Update progress after each message
                    updateBulkProgress();
                    
                    // Delay before next message (except for last one)
                    if (i < phoneList.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, delay * 1000));
                    }
                    
                } catch (error) {
                    console.error('Error in bulk send:', error);
                    bulkStats.failed++;
                    updateBulkProgress();
                }
            }
            
            // Complete bulk sending
            completeBulkSending();
        }

        // Send individual message in bulk (returns promise)
        function sendBulkMessage(phone, message) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Message timeout'));
                }, 30000); // 30 second timeout
                
                const onSent = (data) => {
                    if (data.to.includes(phone)) {
                        socket.off('message_sent', onSent);
                        socket.off('message_failed', onFailed);
                        clearTimeout(timeout);
                        bulkStats.sent++;
                        resolve(data);
                    }
                };
                
                const onFailed = (data) => {
                    if (data.to.includes(phone)) {
                        socket.off('message_sent', onSent);
                        socket.off('message_failed', onFailed);
                        clearTimeout(timeout);
                        bulkStats.failed++;
                        reject(new Error(data.error));
                    }
                };
                
                socket.on('message_sent', onSent);
                socket.on('message_failed', onFailed);
                
                // Send the message
                socket.emit('send_message', {
                    to: phone,
                    message: message
                });
            });
        }

        // Update bulk progress display
        function updateBulkProgress() {
            const progressFill = document.getElementById('progress-fill');
            const sentCount = document.getElementById('sent-count');
            const failedCount = document.getElementById('failed-count');
            const remainingCount = document.getElementById('remaining-count');
            
            const percentage = bulkStats.total > 0 ? Math.round(((bulkStats.sent + bulkStats.failed) / bulkStats.total) * 100) : 0;
            const remaining = bulkStats.total - bulkStats.sent - bulkStats.failed;
            
            progressFill.style.width = percentage + '%';
            progressFill.textContent = percentage + '%';
            
            sentCount.textContent = bulkStats.sent;
            failedCount.textContent = bulkStats.failed;
            remainingCount.textContent = remaining;
        }

        // Complete bulk sending
        function completeBulkSending() {
            bulkSending = false;
            
            document.getElementById('current-number').textContent = 
                `✅ Completed! Sent: ${bulkStats.sent}, Failed: ${bulkStats.failed}`;
            
            const successRate = bulkStats.total > 0 ? Math.round((bulkStats.sent / bulkStats.total) * 100) : 0;
            
            showStatus(
                `🎉 Bulk sending completed! ${bulkStats.sent}/${bulkStats.total} messages sent successfully (${successRate}% success rate)`,
                bulkStats.failed === 0 ? 'success' : 'error'
            );
            
            // Clear form after successful completion
            setTimeout(() => {
                if (bulkStats.failed === 0) {
                    clearBulkForm();
                }
            }, 5000);
        }