
1. Setup your Coolify Base Server: https://community-scripts.org/scripts/debian-13-vm

Copy the run command and run it on your proxmox host.

User default or Advanced - I selected Advanced to setup the below values:

  🧩  Using Advanced Settings
  🆔  Virtual Machine ID: Whatever number you decide goes here
  📦  Machine Type: i440fx
  💾  Disk Size: 100G
  💾  Disk Cache: None
  🏠  Hostname: coolify-base
  🖥️  CPU Model: KVM64
  🧠  CPU Cores: 4
  🛠️  RAM Size: 8192
  🌉  Bridge: vmbr0 (It should select your active network interface on its own)
  🔗  MAC Address: whatever is automatically assigned is fine
  🏷️  VLAN: Default
  ⚙️  Interface MTU Size: Default
  ☁️  Cloud-Init: yes - https://github.com/community-scripts/ProxmoxVE/discussions/272
  🌐  Start VM when completed: yes
  🚀  Creating a Debian 13 VM using the above advanced settings

2. Second verse, same as the first: Setup your Coolify Base Server: https://community-scripts.org/scripts/debian-13-vm

Copy the run command and run it on your proxmox host.

User default or Advanced - I selected Advanced to setup the below values:

  🧩  Using Advanced Settings
  🆔  Virtual Machine ID: Whatever number you decide goes here
  📦  Machine Type: i440fx
  💾  Disk Size: 100G
  💾  Disk Cache: None
  🏠  Hostname: coolify-deploy
  🖥️  CPU Model: KVM64
  🧠  CPU Cores: 4
  🛠️  RAM Size: 8192
  🌉  Bridge: vmbr0 (It should select your active network interface on its own)
  🔗  MAC Address: whatever is automatically assigned is fine
  🏷️  VLAN: Default
  ⚙️  Interface MTU Size: Default
  ☁️  Cloud-Init: yes - https://github.com/community-scripts/ProxmoxVE/discussions/272
  🌐  Start VM when completed: yes
  🚀  Creating a Debian 13 VM using the above advanced settings

3. After getting both VMs setup, head to the coolify-base VM and run the install script: curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash

   A helpful video to follow allow with to finish the setup, and if you have any questions, can be found here (Thanks Christian, for a great walk through): https://www.youtube.com/watch?v=6IZF_VOlOJM

Note: If you're setup behind Nginx Proxy Manager and you add an entry for your coolify base then you'll need to add this one important step:
Under the Advanced tab you want to paste in this Custom Nginx Configuration:

proxy_read_timeout 60;
proxy_connect_timeout 60;
proxy_redirect off;
location /app {
proxy_pass http://<coolifybaseIP>:6001;
}
location /terminal/ws {
proxy_pass http://<coolifybaseIP>:6002;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "Upgrade";
proxy_set_header Host $host;
proxy_cache_bypass $http_upgrade;
}

4. For automated deployments you'll need to setup the connection with Cloudflare tunnels (if you don't have a Cloudflare account, go set one up, it's free).

   a. Follow along with this guide: https://coolify.io/docs/integrations/cloudflare/tunnels/server-ssh (I work through the manual steps, so scroll down to manual steps, but we're going to do a hybrid)
   b. I used the manual method when I set my connection up.
      i. If you were following along with Christian in his tutorial video, he's already walked you through steps 1, 2, 4, and 5 (your Coolify-Base is already connected to your Coolify-Deploy)
   c. Work through step 3 in the documentation. I find it easiest, when choosing the environment in Cloudflare Tunnels to just select docker. Copy your "docker run cloudflare..." info and paste it on a text doc for the next step.
   d. Let's modify the command that Cloudflare gave us for the docker cloudflare tunnel so it looks like this:

docker run -d \
  --name cloudflare-tunnel \
  --restart unless-stopped \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate run --token 123aBc...blah...verylong...token

   e. SSH into your Coolify-Deploy server and run the docker command that you saved in the text doc. 
   f. Once you connected up Cloudflare we can head back into Coolify and use the automated connection.
   g. Go to servers > coolify deploy > cloudflare tunnel and paste in your long token and put in the ssh.domain.com address in and connect. Done.
