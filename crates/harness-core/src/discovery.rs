//! Service discovery for LLM endpoints using mDNS

use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::time::Duration;

use crate::models::EndpointConfig;
use crate::error::Result;

/// Service discovery for finding LLM endpoints on the local network
pub struct ServiceDiscovery {
    daemon: ServiceDaemon,
}

impl ServiceDiscovery {
    pub fn new() -> Result<Self> {
        let daemon = ServiceDaemon::new()
            .map_err(|e| crate::error::Error::Discovery(e.to_string()))?;
        
        Ok(Self { daemon })
    }
    
    /// Search for Ollama services on the network
    pub async fn discover_ollama(&self) -> Result<Vec<EndpointConfig>> {
        // Ollama typically doesn't advertise via mDNS by default,
        // but we can check for common patterns
        let mut endpoints = Vec::new();
        
        // Check for _ollama._tcp service if advertised
        let service_type = "_ollama._tcp.local.";
        let receiver = self.daemon.browse(service_type)
            .map_err(|e| crate::error::Error::Discovery(e.to_string()))?;
        
        // Wait for discoveries with timeout
        let timeout = Duration::from_secs(3);
        let start = std::time::Instant::now();
        
        while start.elapsed() < timeout {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => {
                    if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
                        for addr in info.get_addresses() {
                            let port = info.get_port();
                            let endpoint = EndpointConfig {
                                name: format!("Ollama @ {}:{}", addr, port),
                                base_url: format!("http://{}:{}", addr, port),
                                is_local: true,
                                ..Default::default()
                            };
                            endpoints.push(endpoint);
                        }
                    }
                }
                Err(_) => break, // Timeout
            }
        }
        
        Ok(endpoints)
    }
    
    /// Register the harness service for discovery (optional)
    pub fn register_harness(&self, port: u16) -> Result<()> {
        let service_info = ServiceInfo::new(
            "_homelab-harness._tcp",
            "harness",
            "harness._tcp.local.",
            "",
            port,
            &["path=/"][..],
        )
        .map_err(|e| crate::error::Error::Discovery(e.to_string()))?;
        
        self.daemon.register(service_info)
            .map_err(|e| crate::error::Error::Discovery(e.to_string()))?;
        
        Ok(())
    }
    
    /// Stop the discovery daemon
    pub fn shutdown(&self) {
        let _ = self.daemon.shutdown();
    }
}

impl Default for ServiceDiscovery {
    fn default() -> Self {
        Self::new().expect("Failed to create service discovery")
    }
}
