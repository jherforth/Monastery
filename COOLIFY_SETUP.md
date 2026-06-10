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

   A helpful video to follow allow with if you have any questions can be found here (Thanks Christian, for a great walk through): https://www.youtube.com/watch?v=6IZF_VOlOJM

